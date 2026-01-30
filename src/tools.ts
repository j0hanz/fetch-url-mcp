import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ContentBlock,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

import * as cache from './cache.js';
import { config } from './config.js';
import { FetchError, getErrorMessage, isSystemError } from './errors.js';
import {
  fetchNormalizedUrl,
  normalizeUrl,
  transformToRawUrl,
} from './fetch.js';
import {
  getRequestId,
  logDebug,
  logError,
  logWarn,
  runWithRequestContext,
} from './observability.js';
import type { MarkdownTransformResult } from './transform-types.js';
import { transformHtmlToMarkdown } from './transform.js';
import { isObject } from './type-guards.js';

export interface FetchUrlInput {
  url: string;
}

export interface ToolContentBlock {
  type: 'text';
  text: string;
}

export interface ToolContentResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ToolContentResourceBlock {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text: string;
  };
}

export type ToolContentBlockUnion = ContentBlock;

export type ToolErrorResponse = CallToolResult & {
  structuredContent: {
    error: string;
    url: string;
  };
  isError: true;
};

export type ToolResponseBase = CallToolResult;

export interface FetchPipelineOptions<T> {
  url: string;
  cacheNamespace: string;
  signal?: AbortSignal;
  cacheVary?: Record<string, unknown> | string;
  transform: (html: string, url: string) => T | Promise<T>;
  serialize?: (result: T) => string;
  deserialize?: (cached: string) => T | undefined;
}

export interface PipelineResult<T> {
  data: T;
  fromCache: boolean;
  url: string;
  fetchedAt: string;
  cacheKey?: string | null;
}

export type ProgressToken = string | number;

export interface RequestMeta {
  progressToken?: ProgressToken | undefined;
  [key: string]: unknown;
}

export interface ProgressNotificationParams {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
  _meta?: Record<string, unknown>;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: ProgressNotificationParams;
}

export interface ToolHandlerExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

const TRUNCATION_MARKER = '...[truncated]';
const FETCH_PROGRESS_TOTAL = 4;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

const fetchUrlInputSchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/i })
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe('The URL of the webpage to fetch and convert to Markdown'),
});

const fetchUrlOutputSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe('The fetched URL'),
  inputUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('The original URL provided by the caller'),
  resolvedUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('The normalized or transformed URL that was fetched'),
  title: z.string().max(512).optional().describe('Page title'),
  markdown: z
    .string()
    .max(config.constants.maxInlineContentChars)
    .optional()
    .describe('The extracted content in Markdown format'),
  error: z
    .string()
    .max(2048)
    .optional()
    .describe('Error message if the request failed'),
});

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION = `
Fetches a webpage and converts it to clean Markdown format optimized for LLM context.

This tool is useful for:
- Reading documentation, blog posts, or articles.
- Extracting main content while removing navigation and ads (noise removal).
- Caching content to speed up repeated queries.

Limitations:
- Returns truncated content if it exceeds ${config.constants.maxInlineContentChars} characters.
- Does not execute complex client-side JavaScript interactions.
`.trim();

// Specific icon for the fetch-url tool (download cloud / web)
const TOOL_ICON = {
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPg==',
  mimeType: 'image/svg+xml',
};

interface ProgressReporter {
  report: (progress: number, message: string) => Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * Progress reporting
 * ------------------------------------------------------------------------------------------------- */

class ToolProgressReporter implements ProgressReporter {
  private constructor(
    private readonly token: ProgressToken,
    private readonly sendNotification: (
      notification: ProgressNotification
    ) => Promise<void>
  ) {}

  static create(extra?: ToolHandlerExtra): ProgressReporter {
    const token = extra?._meta?.progressToken ?? null;
    const sendNotification = extra?.sendNotification;

    if (token === null || !sendNotification) {
      return { report: async () => {} };
    }

    return new ToolProgressReporter(token, sendNotification);
  }

  async report(progress: number, message: string): Promise<void> {
    try {
      await Promise.race([
        this.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: this.token,
            progress,
            total: FETCH_PROGRESS_TOTAL,
            message,
          },
        }),
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Progress notification timeout'));
          }, PROGRESS_NOTIFICATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error: unknown) {
      const isTimeout =
        error instanceof Error &&
        error.message === 'Progress notification timeout';
      const logMessage = isTimeout
        ? 'Progress notification timed out'
        : 'Failed to send progress notification';

      logWarn(logMessage, {
        error: getErrorMessage(error),
        progress,
        message,
      });
    }
  }
}

export function createProgressReporter(
  extra?: ToolHandlerExtra
): ProgressReporter {
  return ToolProgressReporter.create(extra);
}

/* -------------------------------------------------------------------------------------------------
 * Inline content limiting
 * ------------------------------------------------------------------------------------------------- */

interface InlineContentResult {
  content?: string;
  contentSize: number;
  resourceUri?: string;
  resourceMimeType?: string;
  error?: string;
  truncated?: boolean;
}

export type InlineResult = ReturnType<InlineContentLimiter['apply']>;

class InlineContentLimiter {
  apply(content: string, cacheKey: string | null): InlineContentResult {
    const contentSize = content.length;
    const inlineLimit = config.constants.maxInlineContentChars;

    if (contentSize <= inlineLimit) {
      return { content, contentSize };
    }

    const resourceUri = this.resolveResourceUri(cacheKey);
    if (!resourceUri) {
      return this.buildTruncatedFallback(content, contentSize, inlineLimit);
    }

    return {
      contentSize,
      resourceUri,
      resourceMimeType: 'text/markdown',
    };
  }

  private resolveResourceUri(cacheKey: string | null): string | null {
    if (!cache.isEnabled() || !cacheKey) return null;
    return cache.toResourceUri(cacheKey);
  }

  private buildTruncatedFallback(
    content: string,
    contentSize: number,
    inlineLimit: number
  ): InlineContentResult {
    const maxContentLength = Math.max(
      0,
      inlineLimit - TRUNCATION_MARKER.length
    );
    const truncatedContent =
      content.length > inlineLimit
        ? `${content.substring(0, maxContentLength)}${TRUNCATION_MARKER}`
        : content;

    return {
      content: truncatedContent,
      contentSize,
      truncated: true,
    };
  }
}

const inlineLimiter = new InlineContentLimiter();

function applyInlineContentLimit(
  content: string,
  cacheKey: string | null
): InlineContentResult {
  return inlineLimiter.apply(content, cacheKey);
}

/* -------------------------------------------------------------------------------------------------
 * Tool response blocks (text + optional resource + optional link)
 * ------------------------------------------------------------------------------------------------- */

function serializeStructuredContent(
  structuredContent: Record<string, unknown>
): string {
  return JSON.stringify(structuredContent);
}

function buildTextBlock(
  structuredContent: Record<string, unknown>
): ToolContentBlock {
  return {
    type: 'text',
    text: serializeStructuredContent(structuredContent),
  };
}

function buildResourceLink(
  inlineResult: InlineResult,
  name: string
): ToolContentResourceLinkBlock | null {
  if (!inlineResult.resourceUri) return null;

  const block: ToolContentResourceLinkBlock = {
    type: 'resource_link',
    uri: inlineResult.resourceUri,
    name,
    description: `Content exceeds inline limit (${config.constants.maxInlineContentChars} chars)`,
  };

  if (inlineResult.resourceMimeType !== undefined) {
    block.mimeType = inlineResult.resourceMimeType;
  }

  return block;
}

function buildEmbeddedResource(
  content: string,
  url: string,
  title?: string
): ToolContentResourceBlock | null {
  if (!content) return null;

  const filename = cache.generateSafeFilename(url, title, undefined, '.md');
  const uri = `file:///${filename}`;

  return {
    type: 'resource',
    resource: {
      uri,
      mimeType: 'text/markdown',
      text: content,
    },
  };
}

function appendResourceBlocks(params: {
  blocks: ToolContentBlockUnion[];
  inlineResult: InlineResult;
  resourceName: string;
  url: string | undefined;
  title: string | undefined;
  fullContent: string | undefined;
}): void {
  const { blocks, inlineResult, resourceName, url, title, fullContent } =
    params;

  const contentToEmbed = config.runtime.httpMode
    ? inlineResult.content
    : (fullContent ?? inlineResult.content);

  if (contentToEmbed && url) {
    const embedded = buildEmbeddedResource(contentToEmbed, url, title);
    if (embedded) blocks.push(embedded);
  }

  const link = buildResourceLink(inlineResult, resourceName);
  if (link) blocks.push(link);
}

type ToolContentBlocks = ReturnType<typeof buildToolContentBlocks>;

function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  _fromCache: boolean,
  inlineResult: InlineResult,
  resourceName: string,
  _cacheKey?: string | null,
  fullContent?: string,
  url?: string,
  title?: string
): ToolContentBlockUnion[] {
  const blocks: ToolContentBlockUnion[] = [buildTextBlock(structuredContent)];

  appendResourceBlocks({
    blocks,
    inlineResult,
    resourceName,
    url,
    title,
    fullContent,
  });

  return blocks;
}

/* -------------------------------------------------------------------------------------------------
 * Fetch pipeline executor (normalize → raw-transform → cache → fetch → transform → persist)
 * ------------------------------------------------------------------------------------------------- */

function resolveNormalizedUrl(url: string): {
  normalizedUrl: string;
  originalUrl: string;
  transformed: boolean;
} {
  const { normalizedUrl: validatedUrl } = normalizeUrl(url);
  const { url: normalizedUrl, transformed } = transformToRawUrl(validatedUrl);
  return { normalizedUrl, originalUrl: validatedUrl, transformed };
}

function logRawUrlTransformation(resolvedUrl: {
  originalUrl: string;
  transformed: boolean;
}): void {
  if (!resolvedUrl.transformed) return;

  logDebug('Using transformed raw content URL', {
    original: resolvedUrl.originalUrl,
  });
}

function extractTitle(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const { title } = value;
  return typeof title === 'string' ? title : undefined;
}

function logCacheMiss(
  reason: string,
  cacheNamespace: string,
  normalizedUrl: string
): void {
  const log = reason === 'deserialize failure' ? logWarn : logDebug;
  log(`Cache miss due to ${reason}`, {
    namespace: cacheNamespace,
    url: normalizedUrl,
  });
}

function attemptCacheRetrieval<T>(params: {
  cacheKey: string | null;
  deserialize: ((cached: string) => T | undefined) | undefined;
  cacheNamespace: string;
  normalizedUrl: string;
}): PipelineResult<T> | null {
  const { cacheKey, deserialize, cacheNamespace, normalizedUrl } = params;
  if (!cacheKey) return null;

  const cached = cache.get(cacheKey);
  if (!cached) return null;

  if (!deserialize) {
    logCacheMiss('missing deserializer', cacheNamespace, normalizedUrl);
    return null;
  }

  const data = deserialize(cached.content);
  if (data === undefined) {
    logCacheMiss('deserialize failure', cacheNamespace, normalizedUrl);
    return null;
  }

  logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });

  return {
    data,
    fromCache: true,
    url: normalizedUrl,
    fetchedAt: cached.fetchedAt,
    cacheKey,
  };
}

function persistCache<T>(params: {
  cacheKey: string | null;
  data: T;
  serialize: ((result: T) => string) | undefined;
  normalizedUrl: string;
}): void {
  const { cacheKey, data, serialize, normalizedUrl } = params;
  if (!cacheKey) return;

  const serializer = serialize ?? JSON.stringify;
  const title = extractTitle(data);

  const metadata = {
    url: normalizedUrl,
    ...(title === undefined ? {} : { title }),
  };

  cache.set(cacheKey, serializer(data), metadata);
}

export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  const resolvedUrl = resolveNormalizedUrl(options.url);
  logRawUrlTransformation(resolvedUrl);

  const cacheKey = cache.createCacheKey(
    options.cacheNamespace,
    resolvedUrl.normalizedUrl,
    options.cacheVary
  );

  const cachedResult = attemptCacheRetrieval({
    cacheKey,
    deserialize: options.deserialize,
    cacheNamespace: options.cacheNamespace,
    normalizedUrl: resolvedUrl.normalizedUrl,
  });
  if (cachedResult) return cachedResult;

  logDebug('Fetching URL', { url: resolvedUrl.normalizedUrl });
  const fetchOptions =
    options.signal === undefined ? {} : { signal: options.signal };

  const html = await fetchNormalizedUrl(
    resolvedUrl.normalizedUrl,
    fetchOptions
  );
  const data = await options.transform(html, resolvedUrl.normalizedUrl);

  if (cache.isEnabled()) {
    persistCache({
      cacheKey,
      data,
      serialize: options.serialize,
      normalizedUrl: resolvedUrl.normalizedUrl,
    });
  }

  return {
    data,
    fromCache: false,
    url: resolvedUrl.normalizedUrl,
    fetchedAt: new Date().toISOString(),
    cacheKey,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Shared fetch helper
 * ------------------------------------------------------------------------------------------------- */

interface SharedFetchOptions<T extends { content: string }> {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly transform: (html: string, normalizedUrl: string) => T | Promise<T>;
  readonly serialize?: (result: T) => string;
  readonly deserialize?: (cached: string) => T | undefined;
}

interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}

export async function performSharedFetch<T extends { content: string }>(
  options: SharedFetchOptions<T>,
  deps: SharedFetchDeps = {}
): Promise<{
  pipeline: PipelineResult<T>;
  inlineResult: InlineResult;
}> {
  const executePipeline = deps.executeFetchPipeline ?? executeFetchPipeline;

  const pipelineOptions: FetchPipelineOptions<T> = {
    url: options.url,
    cacheNamespace: 'markdown',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    transform: options.transform,
    ...(options.serialize ? { serialize: options.serialize } : {}),
    ...(options.deserialize ? { deserialize: options.deserialize } : {}),
  };

  const pipeline = await executePipeline<T>(pipelineOptions);
  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null
  );

  return { pipeline, inlineResult };
}

/* -------------------------------------------------------------------------------------------------
 * Tool error mapping
 * ------------------------------------------------------------------------------------------------- */

export function createToolErrorResponse(
  message: string,
  url: string
): ToolErrorResponse {
  const structuredContent = {
    error: message,
    url,
  };

  return {
    content: [buildTextBlock(structuredContent)],
    structuredContent,
    isError: true,
  };
}

function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === 'VALIDATION_ERROR'
  );
}

function resolveToolErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  if (isValidationError(error) || error instanceof FetchError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${fallbackMessage}: ${error.message}`;
  }
  return `${fallbackMessage}: Unknown error`;
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  const message = resolveToolErrorMessage(error, fallbackMessage);
  return createToolErrorResponse(message, url);
}

/* -------------------------------------------------------------------------------------------------
 * Markdown pipeline (transform + cache codec)
 * ------------------------------------------------------------------------------------------------- */

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

function parseJsonRecord(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveMarkdownContent(
  parsed: Record<string, unknown>
): string | undefined {
  const { markdown } = parsed;
  if (typeof markdown === 'string') return markdown;

  const { content } = parsed;
  if (typeof content === 'string') return content;

  return undefined;
}

function resolveOptionalTitle(
  parsed: Record<string, unknown>
): string | undefined {
  const { title } = parsed;
  if (title === undefined) return undefined;
  return typeof title === 'string' ? title : undefined;
}

function resolveTruncatedFlag(parsed: Record<string, unknown>): boolean {
  const { truncated } = parsed;
  return typeof truncated === 'boolean' ? truncated : false;
}

export function parseCachedMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  const parsed = parseJsonRecord(cached);
  if (!parsed) return undefined;

  const resolvedContent = resolveMarkdownContent(parsed);
  if (resolvedContent === undefined) return undefined;

  const title = resolveOptionalTitle(parsed);
  if (parsed.title !== undefined && title === undefined) return undefined;

  return {
    content: resolvedContent,
    markdown: resolvedContent,
    title,
    truncated: resolveTruncatedFlag(parsed),
  };
}

const markdownTransform = async (
  html: string,
  url: string,
  signal?: AbortSignal
): Promise<MarkdownPipelineResult> => {
  const result = await transformHtmlToMarkdown(html, url, {
    includeMetadata: true,
    ...(signal === undefined ? {} : { signal }),
  });
  return { ...result, content: result.markdown };
};

function serializeMarkdownResult(result: MarkdownPipelineResult): string {
  return JSON.stringify({
    markdown: result.markdown,
    title: result.title,
    truncated: result.truncated,
  });
}

/* -------------------------------------------------------------------------------------------------
 * fetch-url tool implementation
 * ------------------------------------------------------------------------------------------------- */

function buildStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult,
  inputUrl: string
): Record<string, unknown> {
  return {
    url: pipeline.url,
    resolvedUrl: pipeline.url,
    inputUrl,
    title: pipeline.data.title,
    markdown: inlineResult.content,
  };
}

function buildFetchUrlContentBlocks(
  structuredContent: Record<string, unknown>,
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): ToolContentBlocks {
  return buildToolContentBlocks(
    structuredContent,
    pipeline.fromCache,
    inlineResult,
    'Fetched markdown',
    pipeline.cacheKey,
    pipeline.data.content,
    pipeline.url,
    pipeline.data.title
  );
}

function buildResponse(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult,
  inputUrl: string
): ToolResponseBase {
  const structuredContent = buildStructuredContent(
    pipeline,
    inlineResult,
    inputUrl
  );
  const content = buildFetchUrlContentBlocks(
    structuredContent,
    pipeline,
    inlineResult
  );

  return {
    content,
    structuredContent,
  };
}

async function fetchPipeline(
  url: string,
  signal?: AbortSignal,
  progress?: ProgressReporter
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<MarkdownPipelineResult>({
    url,
    ...(signal === undefined ? {} : { signal }),
    transform: async (html, normalizedUrl) => {
      if (progress) {
        await progress.report(3, 'Transforming content');
      }
      return markdownTransform(html, normalizedUrl, signal);
    },
    serialize: serializeMarkdownResult,
    deserialize: parseCachedMarkdownResult,
  });
}

async function executeFetch(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  const { url } = input;
  if (!url) {
    return createToolErrorResponse('URL is required', '');
  }

  const { signal: extraSignal } = extra ?? {};
  const { timeoutMs } = config.tools;

  const signal =
    timeoutMs > 0
      ? AbortSignal.any([
          ...(extraSignal ? [extraSignal] : []),
          AbortSignal.timeout(timeoutMs),
        ])
      : extraSignal;

  const progress = createProgressReporter(extra);

  await progress.report(1, 'Validating URL');

  logDebug('Fetching URL', { url });

  await progress.report(2, 'Fetching content');
  await progress.report(2, 'Fetching content'); // preserve existing behavior

  const { pipeline, inlineResult } = await fetchPipeline(url, signal, progress);

  if (pipeline.fromCache) {
    await progress.report(3, 'Using cached content');
  }

  if (inlineResult.error) {
    return createToolErrorResponse(inlineResult.error, url);
  }

  await progress.report(4, 'Finalizing response');

  return buildResponse(pipeline, inlineResult, url);
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  return executeFetch(input, extra).catch((error: unknown) => {
    logError(
      'fetch-url tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch URL');
  });
}

/* -------------------------------------------------------------------------------------------------
 * MCP tool definition + registration
 * ------------------------------------------------------------------------------------------------- */

type FetchUrlToolHandler = ToolCallback<typeof fetchUrlInputSchema>;

const TOOL_DEFINITION = {
  name: FETCH_URL_TOOL_NAME,
  title: 'Fetch URL',
  description: FETCH_URL_TOOL_DESCRIPTION,
  inputSchema: fetchUrlInputSchema,
  outputSchema: fetchUrlOutputSchema,
  handler: fetchUrlToolHandler,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
} satisfies {
  name: string;
  title: string;
  description: string;
  inputSchema: typeof fetchUrlInputSchema;
  outputSchema: typeof fetchUrlOutputSchema;
  annotations: ToolAnnotations;
  handler: FetchUrlToolHandler;
};

export function withRequestContextIfMissing<TParams, TResult, TExtra = unknown>(
  handler: (params: TParams, extra?: TExtra) => Promise<TResult>
): (params: TParams, extra?: TExtra) => Promise<TResult> {
  return async (params, extra) => {
    const existingRequestId = getRequestId();
    if (existingRequestId) {
      return handler(params, extra);
    }

    const derivedRequestId = resolveRequestIdFromExtra(extra) ?? randomUUID();
    return runWithRequestContext(
      { requestId: derivedRequestId, operationId: derivedRequestId },
      () => handler(params, extra)
    );
  };
}

function resolveRequestIdFromExtra(extra: unknown): string | undefined {
  if (!isObject(extra)) return undefined;
  const { requestId } = extra as { requestId?: unknown };

  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);
  return undefined;
}

export function registerTools(server: McpServer): void {
  if (config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    server.registerTool(
      TOOL_DEFINITION.name,
      {
        title: TOOL_DEFINITION.title,
        description: TOOL_DEFINITION.description,
        inputSchema: TOOL_DEFINITION.inputSchema,
        outputSchema: TOOL_DEFINITION.outputSchema,
        annotations: TOOL_DEFINITION.annotations,
        // Use specific tool icon here
        icons: [TOOL_ICON],
      } as { inputSchema: typeof fetchUrlInputSchema } & Record<
        string,
        unknown
      >,
      withRequestContextIfMissing(TOOL_DEFINITION.handler)
    );
  }
}
