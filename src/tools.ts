import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

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
import {
  type MarkdownTransformResult,
  transformHtmlToMarkdown,
} from './transform.js';
import { isRecord } from './type-guards.js';

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

export type ToolContentBlockUnion =
  | ToolContentBlock
  | ToolContentResourceLinkBlock
  | ToolContentResourceBlock;

export interface ToolErrorResponse {
  [x: string]: unknown;
  content: ToolContentBlockUnion[];
  structuredContent: {
    error: string;
    url: string;
  };
  isError: true;
}

export interface ToolResponseBase {
  [x: string]: unknown;
  content: ToolContentBlockUnion[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface FetchPipelineOptions<T> {
  /** URL to fetch */
  url: string;
  /** Cache namespace (e.g., 'markdown') */
  cacheNamespace: string;
  /** Optional: AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Optional: cache variation input for headers/flags */
  cacheVary?: Record<string, unknown> | string;
  /** Transform function to process HTML into desired format */
  transform: (html: string, url: string) => T | Promise<T>;
  /** Optional: serialize result for caching (defaults to JSON.stringify) */
  serialize?: (result: T) => string;
  /** Optional: deserialize cached content */
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

const fetchUrlInputSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/i }).describe('The URL to fetch'),
});

const fetchUrlOutputSchema = z.strictObject({
  url: z.string().describe('The fetched URL'),
  inputUrl: z
    .string()
    .optional()
    .describe('The original URL provided by the caller'),
  resolvedUrl: z
    .string()
    .optional()
    .describe('The normalized or transformed URL that was fetched'),
  title: z.string().optional().describe('Page title'),
  markdown: z
    .string()
    .optional()
    .describe('The extracted content in Markdown format'),
  error: z.string().optional().describe('Error message if the request failed'),
});

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format';

interface ProgressReporter {
  report: (progress: number, message: string) => Promise<void>;
}

function createProgressReporter(extra?: ToolHandlerExtra): ProgressReporter {
  const token = extra?._meta?.progressToken ?? null;
  const sendNotification = extra?.sendNotification;

  if (token === null || !sendNotification) {
    return { report: async () => {} };
  }

  return {
    report: async (progress: number, message: string): Promise<void> => {
      try {
        await sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress,
            total: FETCH_PROGRESS_TOTAL,
            message,
          },
        });
      } catch (error: unknown) {
        logWarn('Failed to send progress notification', {
          error: getErrorMessage(error),
        });
      }
    },
  };
}

function serializeStructuredContent(
  structuredContent: Record<string, unknown>,
  fromCache: boolean
): string {
  return JSON.stringify(
    structuredContent,
    fromCache ? undefined : null,
    fromCache ? undefined : 2
  );
}

function buildResourceLink(
  inlineResult: InlineResult,
  name: string
): ToolContentResourceLinkBlock | null {
  if (!inlineResult.resourceUri) {
    return null;
  }

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
  if (!content) {
    return null;
  }

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

function resolveContentToEmbed(
  inlineResult: InlineResult,
  fullContent: string | undefined,
  useInlineInHttpMode: boolean
): unknown {
  if (useInlineInHttpMode) {
    return inlineResult.content;
  }
  return fullContent ?? inlineResult.content;
}

function maybeAppendEmbeddedResource(
  blocks: ToolContentBlockUnion[],
  contentToEmbed: unknown,
  url: string | undefined,
  title: string | undefined
): void {
  if (typeof contentToEmbed !== 'string') return;
  if (!url) return;

  const embeddedResource = buildEmbeddedResource(contentToEmbed, url, title);
  if (embeddedResource) {
    blocks.push(embeddedResource);
  }
}

function maybeAppendResourceLink(
  blocks: ToolContentBlockUnion[],
  inlineResult: InlineResult,
  resourceName: string
): void {
  const resourceLink = buildResourceLink(inlineResult, resourceName);
  if (resourceLink) {
    blocks.push(resourceLink);
  }
}

function buildTextBlock(
  structuredContent: Record<string, unknown>,
  fromCache: boolean
): ToolContentBlock {
  return {
    type: 'text',
    text: serializeStructuredContent(structuredContent, fromCache),
  };
}

function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  fromCache: boolean,
  inlineResult: InlineResult,
  resourceName: string,
  cacheKey?: string | null,
  fullContent?: string,
  url?: string,
  title?: string
): ToolContentBlockUnion[] {
  const blocks: ToolContentBlockUnion[] = [
    buildTextBlock(structuredContent, fromCache),
  ];

  const contentToEmbed = resolveContentToEmbed(
    inlineResult,
    fullContent,
    config.runtime.httpMode
  );
  maybeAppendEmbeddedResource(blocks, contentToEmbed, url, title);
  maybeAppendResourceLink(blocks, inlineResult, resourceName);

  return blocks;
}

interface InlineContentResult {
  content?: string;
  contentSize: number;
  resourceUri?: string;
  resourceMimeType?: string;
  error?: string;
  truncated?: boolean;
}

function applyInlineContentLimit(
  content: string,
  cacheKey: string | null
): InlineContentResult {
  const contentSize = content.length;
  const inlineLimit = config.constants.maxInlineContentChars;

  if (contentSize <= inlineLimit) {
    return { content, contentSize };
  }

  const resourceUri = resolveResourceUri(cacheKey);
  if (!resourceUri) {
    return buildTruncatedFallback(content, contentSize, inlineLimit);
  }

  return {
    contentSize,
    resourceUri,
    resourceMimeType: 'text/markdown',
  };
}

function resolveResourceUri(cacheKey: string | null): string | null {
  if (!cache.isEnabled() || !cacheKey) return null;
  return cache.toResourceUri(cacheKey);
}

function buildTruncatedFallback(
  content: string,
  contentSize: number,
  inlineLimit: number
): InlineContentResult {
  const maxContentLength = Math.max(0, inlineLimit - TRUNCATION_MARKER.length);
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

export type InlineResult = ReturnType<typeof applyInlineContentLimit>;

function attemptCacheRetrieval<T>({
  cacheKey,
  deserialize,
  cacheNamespace,
  normalizedUrl,
}: {
  cacheKey: string | null;
  deserialize: ((cached: string) => T | undefined) | undefined;
  cacheNamespace: string;
  normalizedUrl: string;
}): PipelineResult<T> | null {
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

function resolveNormalizedUrl(url: string): {
  normalizedUrl: string;
  originalUrl: string;
  transformed: boolean;
} {
  const { normalizedUrl: validatedUrl } = normalizeUrl(url);
  const { url: normalizedUrl, transformed } = transformToRawUrl(validatedUrl);
  return { normalizedUrl, originalUrl: validatedUrl, transformed };
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

function persistCache<T>({
  cacheKey,
  data,
  serialize,
  normalizedUrl,
}: {
  cacheKey: string | null;
  data: T;
  serialize: ((result: T) => string) | undefined;
  normalizedUrl: string;
}): void {
  if (!cacheKey) return;
  const serializer = serialize ?? JSON.stringify;
  const title = extractTitle(data);
  const metadata = {
    url: normalizedUrl,
    ...(title === undefined ? {} : { title }),
  };
  cache.set(cacheKey, serializer(data), metadata);
}

function extractTitle(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { title } = value;
  return typeof title === 'string' ? title : undefined;
}

function logCacheMiss(
  reason: string,
  cacheNamespace: string,
  normalizedUrl: string
): void {
  // Deserialize failures indicate unexpected data; surface at warn level.
  const log = reason === 'deserialize failure' ? logWarn : logDebug;
  log(`Cache miss due to ${reason}`, {
    namespace: cacheNamespace,
    url: normalizedUrl,
  });
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

function applyOptionalPipelineSerialization<T extends { content: string }>(
  pipelineOptions: FetchPipelineOptions<T>,
  options: SharedFetchOptions<T>
): void {
  if (options.serialize !== undefined) {
    pipelineOptions.serialize = options.serialize;
  }

  if (options.deserialize !== undefined) {
    pipelineOptions.deserialize = options.deserialize;
  }
}

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
  };

  applyOptionalPipelineSerialization(pipelineOptions, options);

  const pipeline = await executePipeline<T>(pipelineOptions);

  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null
  );

  return { pipeline, inlineResult };
}

export function createToolErrorResponse(
  message: string,
  url: string
): ToolErrorResponse {
  const structuredContent = {
    error: message,
    url,
  };

  return {
    content: [buildTextBlock(structuredContent, true)],
    structuredContent,
    isError: true,
  };
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  const message = resolveToolErrorMessage(error, fallbackMessage);
  return createToolErrorResponse(message, url);
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

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

type ToolContentBlocks = ReturnType<typeof buildToolContentBlocks>;

function parseJsonRecord(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : undefined;
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
  if (!isRecord(extra)) return undefined;
  const { requestId } = extra;
  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);
  return undefined;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    TOOL_DEFINITION.name,
    {
      title: TOOL_DEFINITION.title,
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      outputSchema: TOOL_DEFINITION.outputSchema,
      annotations: TOOL_DEFINITION.annotations,
    },
    withRequestContextIfMissing(TOOL_DEFINITION.handler)
  );
}
