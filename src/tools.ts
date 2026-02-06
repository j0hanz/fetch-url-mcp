import { AsyncLocalStorage } from 'node:async_hooks';
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
  fetchNormalizedUrlBuffer,
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
import { createUnrefTimeout } from './timer-utils.js';
import type { MarkdownTransformResult } from './transform-types.js';
import { transformBufferToMarkdown } from './transform.js';
import { isObject } from './type-guards.js';

export interface FetchUrlInput {
  url: string;
  skipNoiseRemoval?: boolean | undefined;
  forceRefresh?: boolean | undefined;
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
    statusCode?: number;
    details?: Record<string, unknown>;
  };
  isError: true;
};

export type ToolResponseBase = CallToolResult;

export interface FetchPipelineOptions<T> {
  url: string;
  cacheNamespace: string;
  signal?: AbortSignal;
  cacheVary?: Record<string, unknown> | string;
  forceRefresh?: boolean;
  transform: (
    input: { buffer: Uint8Array; encoding: string },
    url: string
  ) => T | Promise<T>;
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
  sessionId?: unknown;
  requestInfo?: unknown;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

const TRUNCATION_MARKER = '...[truncated]';
const FETCH_PROGRESS_TOTAL = 4;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

export const fetchUrlInputSchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/i })
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe('The URL of the webpage to fetch and convert to Markdown'),
  skipNoiseRemoval: z
    .boolean()
    .optional()
    .describe(
      'When true, preserves navigation, footers, and other elements normally filtered as noise'
    ),
  forceRefresh: z
    .boolean()
    .optional()
    .describe(
      'When true, bypasses the cache and fetches fresh content from the URL'
    ),
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
  truncated: z
    .boolean()
    .optional()
    .describe('Whether the returned markdown was truncated'),
  error: z
    .string()
    .max(2048)
    .optional()
    .describe('Error message if the request failed'),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe('HTTP status code for failed requests'),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Additional error details when available'),
});

export const FETCH_URL_TOOL_NAME = 'fetch-url';
const FETCH_URL_TOOL_DESCRIPTION = `
Fetches a webpage and converts it to clean Markdown format optimized for LLM context.

This tool is useful for:
- Reading documentation, blog posts, or articles.
- Extracting main content while removing navigation and ads (noise removal).
- Caching content to speed up repeated queries.

Limitations:
- Inline output may be truncated when MAX_INLINE_CONTENT_CHARS is set.
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

type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

/* -------------------------------------------------------------------------------------------------
 * Small runtime helpers
 * ------------------------------------------------------------------------------------------------- */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return isObject(value) ? (value as JsonRecord) : undefined;
}

function readUnknown(obj: unknown, key: string): unknown {
  const record = asRecord(obj);
  return record ? record[key] : undefined;
}

function readString(obj: unknown, key: string): string | undefined {
  const value = readUnknown(obj, key);
  return typeof value === 'string' ? value : undefined;
}

function readNestedRecord(
  obj: unknown,
  keys: readonly string[]
): JsonRecord | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    current = readUnknown(current, key);
    if (current === undefined) return undefined;
  }
  return asRecord(current);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function withSignal(
  signal?: AbortSignal
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}

function buildToolAbortSignal(
  extraSignal: AbortSignal | undefined
): AbortSignal | undefined {
  const { timeoutMs } = config.tools;
  if (timeoutMs <= 0) return extraSignal;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!extraSignal) return timeoutSignal;

  return AbortSignal.any([extraSignal, timeoutSignal]);
}

/* -------------------------------------------------------------------------------------------------
 * Progress reporting
 * ------------------------------------------------------------------------------------------------- */

function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  const related = readUnknown(meta, 'io.modelcontextprotocol/related-task');
  const taskId = readString(related, 'taskId');
  return taskId ? { taskId } : undefined;
}

class ToolProgressReporter implements ProgressReporter {
  private constructor(
    private readonly token: ProgressToken,
    private readonly sendNotification: (
      notification: ProgressNotification
    ) => Promise<void>,
    private readonly relatedTaskMeta: { taskId: string } | undefined,
    private readonly runInContext: RunInContext
  ) {}

  static create(extra?: ToolHandlerExtra): ProgressReporter {
    const token = extra?._meta?.progressToken ?? null;
    const sendNotification = extra?.sendNotification;
    const relatedTaskMeta = resolveRelatedTaskMeta(extra?._meta);

    if (token === null || !sendNotification) {
      return { report: async () => {} };
    }

    const runInContext = AsyncLocalStorage.snapshot();
    return new ToolProgressReporter(
      token,
      sendNotification,
      relatedTaskMeta,
      runInContext
    );
  }

  async report(progress: number, message: string): Promise<void> {
    return this.runInContext(() => this.reportInContext(progress, message));
  }

  private async reportInContext(
    progress: number,
    message: string
  ): Promise<void> {
    const notification: ProgressNotification = {
      method: 'notifications/progress',
      params: {
        progressToken: this.token,
        progress,
        total: FETCH_PROGRESS_TOTAL,
        message,
        ...(this.relatedTaskMeta
          ? {
              _meta: {
                'io.modelcontextprotocol/related-task': this.relatedTaskMeta,
              },
            }
          : {}),
      },
    };

    const timeout = createUnrefTimeout(PROGRESS_NOTIFICATION_TIMEOUT_MS, {
      timeout: true as const,
    });

    try {
      const sendOutcome = this.sendNotification(notification)
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      const outcome = await Promise.race([sendOutcome, timeout.promise]);

      if ('timeout' in outcome) {
        logWarn('Progress notification timed out', {
          progress,
          message,
        });
        return;
      }

      if (!outcome.ok) {
        logWarn('Failed to send progress notification', {
          error: getErrorMessage(outcome.error),
          progress,
          message,
        });
      }
    } finally {
      timeout.cancel();
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

function getOpenCodeFence(
  content: string
): { fenceChar: string; fenceLength: number } | null {
  const lines = content.split('\n');
  let inFence = false;
  let fenceChar: string | null | undefined = null;
  let fenceLength = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Check for fence markers (``` or ~~~)
    const match = /^(`{3,}|~{3,})/.exec(trimmed);

    if (match) {
      const marker = match[0];
      const char = marker[0];
      const { length } = marker;

      if (!inFence) {
        // Opening fence
        inFence = true;
        fenceChar = char;
        fenceLength = length;
      } else if (char === fenceChar && length >= fenceLength) {
        // Closing fence (same character, at least as many repetitions)
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
      }
    }
  }

  if (!inFence || !fenceChar) return null;
  return { fenceChar, fenceLength };
}

function findSafeLinkBoundary(content: string): number {
  const lastBracket = content.lastIndexOf('[');
  if (lastBracket === -1) return content.length;
  const afterBracket = content.substring(lastBracket);
  const closedPattern = /^\[[^\]]*\]\([^)]*\)/;
  if (closedPattern.test(afterBracket)) return content.length;
  const start =
    lastBracket > 0 && content[lastBracket - 1] === '!'
      ? lastBracket - 1
      : lastBracket;
  return start;
}

function truncateWithMarker(
  content: string,
  limit: number,
  marker: string
): string {
  if (content.length <= limit) return content;

  const maxContentLength = Math.max(0, limit - marker.length);
  let truncatedContent = content.substring(0, maxContentLength);

  // Check if we're inside an open code fence
  const openFence = getOpenCodeFence(truncatedContent);
  if (openFence) {
    // Add a matching closing fence before the marker
    const fenceCloser = `\n${openFence.fenceChar.repeat(openFence.fenceLength)}\n`;
    const adjustedLength = Math.max(
      0,
      limit - marker.length - fenceCloser.length
    );
    return `${content.substring(0, adjustedLength)}${fenceCloser}${marker}`;
  }

  const safeBoundary = findSafeLinkBoundary(truncatedContent);
  if (safeBoundary < truncatedContent.length) {
    truncatedContent = truncatedContent.substring(0, safeBoundary);
  }

  return `${truncatedContent}${marker}`;
}

class InlineContentLimiter {
  apply(content: string, cacheKey: string | null): InlineContentResult {
    const contentSize = content.length;
    const inlineLimit = config.constants.maxInlineContentChars;

    if (inlineLimit <= 0) {
      return { content, contentSize };
    }

    if (contentSize <= inlineLimit) {
      return { content, contentSize };
    }

    const isTruncated = contentSize > inlineLimit;
    const resourceUri =
      cacheKey && (cache.isEnabled() || isTruncated)
        ? cache.toResourceUri(cacheKey)
        : null;

    const truncatedContent = truncateWithMarker(
      content,
      inlineLimit,
      TRUNCATION_MARKER
    );

    if (resourceUri) {
      return {
        content: truncatedContent,
        contentSize,
        resourceUri,
        resourceMimeType: 'text/markdown',
        truncated: true,
      };
    }

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

function buildTextBlock(
  structuredContent: Record<string, unknown>
): ToolContentBlock {
  return {
    type: 'text',
    text: JSON.stringify(structuredContent),
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
  const uri = new URL(filename, 'file:///').href;

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

function buildToolContentBlocks(params: {
  structuredContent: Record<string, unknown>;
  inlineResult: InlineResult;
  resourceName: string;
  url?: string;
  title?: string;
  fullContent?: string;
}): ToolContentBlockUnion[] {
  const blocks: ToolContentBlockUnion[] = [
    buildTextBlock(params.structuredContent),
  ];

  appendResourceBlocks({
    blocks,
    inlineResult: params.inlineResult,
    resourceName: params.resourceName,
    url: params.url,
    title: params.title,
    fullContent: params.fullContent,
  });

  return blocks;
}

/* -------------------------------------------------------------------------------------------------
 * Fetch pipeline executor (normalize → raw-transform → cache → fetch → transform → persist)
 * ------------------------------------------------------------------------------------------------- */

interface UrlResolution {
  normalizedUrl: string;
  originalUrl: string;
  transformed: boolean;
}

function resolveNormalizedUrl(url: string): UrlResolution {
  const { normalizedUrl: validatedUrl } = normalizeUrl(url);
  const { url: normalizedUrl, transformed } = transformToRawUrl(validatedUrl);
  return { normalizedUrl, originalUrl: validatedUrl, transformed };
}

function logRawUrlTransformation(resolvedUrl: UrlResolution): void {
  if (!resolvedUrl.transformed) return;

  logDebug('Using transformed raw content URL', {
    original: resolvedUrl.originalUrl,
  });
}

function extractTitle(value: unknown): string | undefined {
  const record = asRecord(value);
  const title = record ? record.title : undefined;
  return typeof title === 'string' ? title : undefined;
}

function logCacheMiss(
  reason: string,
  cacheNamespace: string,
  normalizedUrl: string,
  error?: unknown
): void {
  const log = reason.startsWith('deserialize') ? logWarn : logDebug;
  log(`Cache miss due to ${reason}`, {
    namespace: cacheNamespace,
    url: normalizedUrl,
    ...(error ? { error: getErrorMessage(error) } : {}),
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

  let data: T | undefined;
  try {
    data = deserialize(cached.content);
  } catch (error: unknown) {
    logCacheMiss('deserialize exception', cacheNamespace, normalizedUrl, error);
    return null;
  }

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
  cacheNamespace: string;
  force?: boolean;
}): void {
  const { cacheKey, data, serialize, normalizedUrl, cacheNamespace, force } =
    params;
  if (!cacheKey) return;

  const serializer = serialize ?? JSON.stringify;
  const title = extractTitle(data);
  const metadata = {
    url: normalizedUrl,
    ...(title === undefined ? {} : { title }),
  };

  try {
    cache.set(
      cacheKey,
      serializer(data),
      metadata,
      force ? { force: true } : undefined
    );
  } catch (error: unknown) {
    logWarn('Failed to persist cache entry', {
      namespace: cacheNamespace,
      url: normalizedUrl,
      error: getErrorMessage(error),
    });
  }
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

  if (!options.forceRefresh) {
    const cachedResult = attemptCacheRetrieval({
      cacheKey,
      deserialize: options.deserialize,
      cacheNamespace: options.cacheNamespace,
      normalizedUrl: resolvedUrl.normalizedUrl,
    });
    if (cachedResult) return cachedResult;
  }

  logDebug('Fetching URL', { url: resolvedUrl.normalizedUrl });

  const { buffer, encoding } = await fetchNormalizedUrlBuffer(
    resolvedUrl.normalizedUrl,
    withSignal(options.signal)
  );
  const data = await options.transform(
    { buffer, encoding },
    resolvedUrl.normalizedUrl
  );

  if (cache.isEnabled()) {
    persistCache({
      cacheKey,
      data,
      serialize: options.serialize,
      normalizedUrl: resolvedUrl.normalizedUrl,
      cacheNamespace: options.cacheNamespace,
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
  readonly cacheVary?: Record<string, unknown> | string;
  readonly forceRefresh?: boolean;
  readonly transform: (
    input: { buffer: Uint8Array; encoding: string },
    normalizedUrl: string
  ) => T | Promise<T>;
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
    ...withSignal(options.signal),
    ...(options.cacheVary ? { cacheVary: options.cacheVary } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    transform: options.transform,
    ...(options.serialize ? { serialize: options.serialize } : {}),
    ...(options.deserialize ? { deserialize: options.deserialize } : {}),
  };

  const pipeline = await executePipeline<T>(pipelineOptions);
  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null
  );

  if (inlineResult.truncated && !pipeline.fromCache && !cache.isEnabled()) {
    persistCache({
      cacheKey: pipeline.cacheKey ?? null,
      data: pipeline.data,
      serialize: options.serialize,
      normalizedUrl: pipeline.url,
      cacheNamespace: 'markdown',
      force: true,
    });
  }

  return { pipeline, inlineResult };
}

/* -------------------------------------------------------------------------------------------------
 * Tool error mapping
 * ------------------------------------------------------------------------------------------------- */

export function createToolErrorResponse(
  message: string,
  url: string,
  extra?: { statusCode?: number; details?: Record<string, unknown> }
): ToolErrorResponse {
  const structuredContent = {
    error: message,
    url,
    ...(extra?.statusCode !== undefined
      ? { statusCode: extra.statusCode }
      : {}),
    ...(extra?.details ? { details: extra.details } : {}),
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
  if (error instanceof FetchError) {
    return createToolErrorResponse(message, url, {
      statusCode: error.statusCode,
      details: error.details,
    });
  }
  return createToolErrorResponse(message, url);
}

/* -------------------------------------------------------------------------------------------------
 * Markdown pipeline (transform + cache codec)
 * ------------------------------------------------------------------------------------------------- */

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

const cachedMarkdownSchema = z
  .object({
    markdown: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
    truncated: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .refine(
    (value) =>
      typeof value.markdown === 'string' || typeof value.content === 'string',
    { message: 'Missing markdown/content' }
  );

export function parseCachedMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  const parsed = safeJsonParse(cached);
  const result = cachedMarkdownSchema.safeParse(parsed);
  if (!result.success) return undefined;

  const markdown = result.data.markdown ?? result.data.content;
  if (typeof markdown !== 'string') return undefined;

  return {
    content: markdown,
    markdown,
    title: result.data.title,
    truncated: result.data.truncated ?? false,
  };
}

const markdownTransform = async (
  input: { buffer: Uint8Array; encoding: string },
  url: string,
  signal?: AbortSignal,
  skipNoiseRemoval?: boolean
): Promise<MarkdownPipelineResult> => {
  const result = await transformBufferToMarkdown(input.buffer, url, {
    includeMetadata: true,
    encoding: input.encoding,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
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
  const truncated = inlineResult.truncated ?? pipeline.data.truncated;

  return {
    url: pipeline.url,
    resolvedUrl: pipeline.url,
    inputUrl,
    title: pipeline.data.title,
    markdown: inlineResult.content,
    ...(truncated ? { truncated: true } : {}),
  };
}

function buildFetchUrlContentBlocks(
  structuredContent: Record<string, unknown>,
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): ToolContentBlocks {
  return buildToolContentBlocks({
    structuredContent,
    inlineResult,
    resourceName: 'Fetched markdown',
    url: pipeline.url,
    ...(pipeline.data.title !== undefined && { title: pipeline.data.title }),
    fullContent: pipeline.data.content,
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

async function fetchPipeline(
  url: string,
  signal?: AbortSignal,
  progress?: ProgressReporter,
  skipNoiseRemoval?: boolean,
  forceRefresh?: boolean
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<MarkdownPipelineResult>({
    url,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { cacheVary: { skipNoiseRemoval: true } } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    transform: async ({ buffer, encoding }, normalizedUrl) => {
      if (progress) {
        void progress.report(3, 'Transforming content');
      }
      return markdownTransform(
        { buffer, encoding },
        normalizedUrl,
        signal,
        skipNoiseRemoval
      );
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

  const signal = buildToolAbortSignal(extra?.signal);
  const progress = createProgressReporter(extra);

  void progress.report(1, 'Validating URL');
  logDebug('Fetching URL', { url });

  void progress.report(2, 'Fetching content');
  const { pipeline, inlineResult } = await fetchPipeline(
    url,
    signal,
    progress,
    input.skipNoiseRemoval,
    input.forceRefresh
  );

  if (pipeline.fromCache) {
    void progress.report(3, 'Using cached content');
  }

  if (inlineResult.error) {
    return createToolErrorResponse(inlineResult.error, url);
  }

  void progress.report(4, 'Finalizing response');
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
  execution: {
    taskSupport: 'optional',
  },
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
  execution: { taskSupport: 'optional' | 'required' | 'forbidden' };
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
    const derivedSessionId = resolveSessionIdFromExtra(extra);

    return runWithRequestContext(
      {
        requestId: derivedRequestId,
        operationId: derivedRequestId,
        ...(derivedSessionId ? { sessionId: derivedSessionId } : {}),
      },
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

function resolveSessionIdFromExtra(extra: unknown): string | undefined {
  if (!isObject(extra)) return undefined;

  const { sessionId } = extra as { sessionId?: unknown };
  if (typeof sessionId === 'string') return sessionId;

  const headers = readNestedRecord(extra, ['requestInfo', 'headers']);
  const headerValue = headers ? headers['mcp-session-id'] : undefined;

  return typeof headerValue === 'string' ? headerValue : undefined;
}

export function registerTools(server: McpServer): void {
  if (!config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) return;

  server.registerTool(
    TOOL_DEFINITION.name,
    {
      title: TOOL_DEFINITION.title,
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      outputSchema: TOOL_DEFINITION.outputSchema,
      annotations: TOOL_DEFINITION.annotations,
      execution: TOOL_DEFINITION.execution,
      // Use specific tool icon here
      icons: [TOOL_ICON],
    } as { inputSchema: typeof fetchUrlInputSchema } & Record<string, unknown>,
    withRequestContextIfMissing(TOOL_DEFINITION.handler)
  );
}
