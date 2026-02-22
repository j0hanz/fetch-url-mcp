import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ContentBlock,
  TextResourceContents,
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
import type { MarkdownTransformResult } from './transform-types.js';
import { transformBufferToMarkdown } from './transform.js';
import { isObject } from './type-guards.js';

export interface FetchUrlInput {
  url: string;
  skipNoiseRemoval?: boolean | undefined;
  forceRefresh?: boolean | undefined;
  maxInlineChars?: number | undefined;
}

interface ToolContentBlock {
  type: 'text';
  text: string;
}

type ToolContentBlockUnion = ContentBlock;

type ToolErrorResponse = CallToolResult & {
  isError: true;
};

type ToolResponseBase = CallToolResult & {
  structuredContent?: Record<string, unknown> | undefined;
};

interface FetchPipelineOptions<T> {
  url: string;
  cacheNamespace: string;
  signal?: AbortSignal;
  cacheVary?: Record<string, unknown> | string;
  forceRefresh?: boolean;
  transform: (
    input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
    url: string
  ) => T | Promise<T>;
  serialize?: (result: T) => string;
  deserialize?: (cached: string) => T | undefined;
}

interface PipelineResult<T> {
  data: T;
  fromCache: boolean;
  url: string;
  originalUrl?: string;
  finalUrl?: string;
  fetchedAt: string;
  cacheKey?: string | null;
}

type ProgressToken = string | number;

interface RequestMeta {
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

interface ToolHandlerExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  sessionId?: unknown;
  requestInfo?: unknown;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  onProgress?: (progress: number, message: string) => void;
}

const TRUNCATION_MARKER = '...[truncated]';
const FETCH_PROGRESS_TOTAL = 4;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

export const fetchUrlInputSchema = z.strictObject({
  url: z
    .url({ protocol: /^https?$/i })
    .min(1)
    .max(config.constants.maxUrlLength)
    .describe(
      `The URL of the webpage to fetch and convert to Markdown. Max ${config.constants.maxUrlLength} characters.`
    ),
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
  maxInlineChars: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlSize)
    .optional()
    .describe(
      `Optional per-call inline markdown limit (0 to ${config.constants.maxHtmlSize}). 0 means unlimited. If a global inline limit is configured, the lower value is used.`
    ),
});

export const fetchUrlOutputSchema = z.strictObject({
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
  finalUrl: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe('The final response URL after redirects'),
  cacheResourceUri: z
    .string()
    .max(config.constants.maxUrlLength)
    .optional()
    .describe(
      'Internal cache resource URI for retrieving full markdown via resources/read'
    ),
  title: z.string().max(512).optional().describe('Page title'),
  metadata: z
    .strictObject({
      title: z.string().max(512).optional().describe('Detected page title'),
      description: z
        .string()
        .max(2048)
        .optional()
        .describe('Detected page description'),
      author: z.string().max(512).optional().describe('Detected page author'),
      image: z
        .string()
        .max(config.constants.maxUrlLength)
        .optional()
        .describe('Detected page preview image URL'),
      favicon: z
        .string()
        .max(config.constants.maxUrlLength)
        .optional()
        .describe('Detected page favicon URL'),
      publishedAt: z
        .string()
        .max(64)
        .optional()
        .describe('Detected publication date (if present)'),
      modifiedAt: z
        .string()
        .max(64)
        .optional()
        .describe('Detected last modified date (if present)'),
    })
    .optional()
    .describe('Detected metadata extracted from page markup'),
  markdown: (config.constants.maxInlineContentChars > 0
    ? z.string().max(config.constants.maxInlineContentChars)
    : z.string()
  )
    .optional()
    .describe(
      'The extracted content in Markdown format. May be truncated if exceeding inline limits; check "truncated" field'
    ),
  fromCache: z
    .boolean()
    .optional()
    .describe('Whether this response was served from cache'),
  fetchedAt: z
    .string()
    .max(64)
    .optional()
    .describe('ISO timestamp of fetch/cache retrieval time'),
  contentSize: z
    .number()
    .int()
    .min(0)
    .max(config.constants.maxHtmlSize * 4)
    .optional()
    .describe('Full markdown size in characters before inline truncation'),
  truncated: z
    .boolean()
    .optional()
    .describe('Whether the returned markdown was truncated'),
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
  private reportQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly token: ProgressToken | null,
    private readonly sendNotification:
      | ((notification: ProgressNotification) => Promise<void>)
      | undefined,
    private readonly relatedTaskMeta: { taskId: string } | undefined,
    private readonly onProgress:
      | ((progress: number, message: string) => void)
      | undefined
  ) {}

  static create(extra?: ToolHandlerExtra): ProgressReporter {
    const token = extra?._meta?.progressToken ?? null;
    const sendNotification = extra?.sendNotification;
    const relatedTaskMeta = resolveRelatedTaskMeta(extra?._meta);
    const onProgress = extra?.onProgress;

    if (token === null && !onProgress) {
      return { report: async () => {} };
    }

    return new ToolProgressReporter(
      token,
      sendNotification,
      relatedTaskMeta,
      onProgress
    );
  }

  async report(progress: number, message: string): Promise<void> {
    if (this.onProgress) {
      try {
        this.onProgress(progress, message);
      } catch (error: unknown) {
        logWarn('Progress callback failed', {
          error: getErrorMessage(error),
          progress,
          message,
        });
      }
    }

    if (this.token === null || !this.sendNotification) return;
    const { sendNotification } = this;

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

    this.reportQueue = this.reportQueue.then(async () => {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ timeout: true });
        }, PROGRESS_NOTIFICATION_TIMEOUT_MS);
        timeoutId.unref();
      });

      try {
        const outcome = await Promise.race([
          sendNotification(notification).then(() => ({ ok: true as const })),
          timeoutPromise,
        ]);

        if ('timeout' in outcome) {
          logWarn('Progress notification timed out', { progress, message });
        }
      } catch (error) {
        logWarn('Failed to send progress notification', {
          error: getErrorMessage(error),
          progress,
          message,
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    });

    await this.reportQueue;
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
  truncated?: boolean;
}

type InlineResult = ReturnType<InlineContentLimiter['apply']>;

function getOpenCodeFence(
  content: string
): { fenceChar: string; fenceLength: number } | null {
  const FENCE_PATTERN = /^([ \t]*)(`{3,}|~{3,})/gm;
  let match;
  let inFence = false;
  let fenceChar: string | null = null;
  let fenceLength = 0;

  while ((match = FENCE_PATTERN.exec(content)) !== null) {
    const marker = match[2];
    if (!marker) continue;

    const [char] = marker;
    if (!char) continue;
    const { length } = marker;

    if (!inFence) {
      inFence = true;
      fenceChar = char;
      fenceLength = length;
    } else if (char === fenceChar && length >= fenceLength) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  }

  if (inFence && fenceChar) {
    return { fenceChar, fenceLength };
  }
  return null;
}

function findSafeLinkBoundary(content: string, limit: number): number {
  const lastBracket = content.lastIndexOf('[', limit);
  if (lastBracket === -1) return limit;
  const afterBracket = content.substring(lastBracket, limit);
  const closedPattern = /^\[[^\]]*\]\([^)]*\)/;
  if (closedPattern.test(afterBracket)) return limit;
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
  const tentativeContent = content.substring(0, maxContentLength);
  const openFence = getOpenCodeFence(tentativeContent);
  if (openFence) {
    const fenceCloser = `\n${openFence.fenceChar.repeat(openFence.fenceLength)}\n`;
    const adjustedLength = Math.max(
      0,
      limit - marker.length - fenceCloser.length
    );
    return `${content.substring(0, adjustedLength)}${fenceCloser}${marker}`;
  }

  const safeBoundary = findSafeLinkBoundary(content, maxContentLength);
  if (safeBoundary < maxContentLength) {
    return `${content.substring(0, safeBoundary)}${marker}`;
  }

  return `${tentativeContent}${marker}`;
}

function appendTruncationMarker(content: string, marker: string): string {
  if (!content) return marker;
  if (content.endsWith(marker)) return content;

  const openFence = getOpenCodeFence(content);
  const contentWithFence = openFence
    ? `${content}\n${openFence.fenceChar.repeat(openFence.fenceLength)}\n`
    : content;

  const safeBoundary = findSafeLinkBoundary(
    contentWithFence,
    contentWithFence.length
  );
  if (safeBoundary < contentWithFence.length) {
    return `${contentWithFence.substring(0, safeBoundary)}${marker}`;
  }

  return `${contentWithFence}${marker}`;
}

class InlineContentLimiter {
  apply(content: string, inlineLimitOverride?: number): InlineContentResult {
    const contentSize = content.length;
    const inlineLimit = this.resolveInlineLimit(inlineLimitOverride);

    if (inlineLimit <= 0) {
      return { content, contentSize };
    }

    if (contentSize <= inlineLimit) {
      return { content, contentSize };
    }

    const truncatedContent = truncateWithMarker(
      content,
      inlineLimit,
      TRUNCATION_MARKER
    );

    return {
      content: truncatedContent,
      contentSize,
      truncated: true,
    };
  }

  private resolveInlineLimit(inlineLimitOverride?: number): number {
    const globalLimit = config.constants.maxInlineContentChars;

    if (inlineLimitOverride === undefined) return globalLimit;
    if (globalLimit > 0 && inlineLimitOverride > 0) {
      return Math.min(inlineLimitOverride, globalLimit);
    }
    if (globalLimit > 0 && inlineLimitOverride === 0) return globalLimit;

    return inlineLimitOverride;
  }
}

const inlineLimiter = new InlineContentLimiter();

function applyInlineContentLimit(
  content: string,
  inlineLimitOverride?: number
): InlineContentResult {
  return inlineLimiter.apply(content, inlineLimitOverride);
}

/* -------------------------------------------------------------------------------------------------
 * Tool response blocks (text + optional embedded resource)
 * ------------------------------------------------------------------------------------------------- */

function buildTextBlock(
  structuredContent: Record<string, unknown>
): ToolContentBlock {
  return {
    type: 'text',
    text: JSON.stringify(structuredContent),
  };
}

function buildEmbeddedResource(
  content: string,
  url: string,
  title?: string
): ToolContentBlockUnion | null {
  if (!content) return null;

  const filename = cache.generateSafeFilename(url, title, undefined, '.md');
  const uri = new URL(filename, 'file:///').href;

  const resource: TextResourceContents = {
    uri,
    mimeType: 'text/markdown',
    text: content,
  };

  return {
    type: 'resource',
    resource,
  };
}

function buildCacheResourceLink(
  cacheResourceUri: string,
  contentSize: number,
  fetchedAt: string
): ToolContentBlockUnion {
  return {
    type: 'resource_link',
    uri: cacheResourceUri,
    name: 'cached-markdown',
    title: 'Cached Fetch Output',
    description: 'Read full markdown via resources/read.',
    mimeType: 'text/markdown',
    ...(contentSize > 0 ? { size: contentSize } : {}),
    annotations: {
      audience: ['assistant'] as ['assistant'],
      priority: 0.8,
      lastModified: fetchedAt,
    },
  };
}

function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  resourceLink?: ToolContentBlockUnion | null,
  embeddedResource?: ToolContentBlockUnion | null
): ToolContentBlockUnion[] {
  const blocks: ToolContentBlockUnion[] = [buildTextBlock(structuredContent)];

  if (resourceLink) {
    blocks.push(resourceLink);
  }

  if (embeddedResource) {
    blocks.push(embeddedResource);
  }

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
  const transformedResult = transformToRawUrl(validatedUrl);
  if (!transformedResult.transformed) {
    return {
      normalizedUrl: validatedUrl,
      originalUrl: validatedUrl,
      transformed: false,
    };
  }

  // Re-validate transformed URLs so blocked-host and length policies still apply.
  const { normalizedUrl: transformedUrl } = normalizeUrl(transformedResult.url);
  return {
    normalizedUrl: transformedUrl,
    originalUrl: validatedUrl,
    transformed: true,
  };
}

function logRawUrlTransformation(resolvedUrl: UrlResolution): void {
  if (!resolvedUrl.transformed) return;

  logDebug('Using transformed raw content URL', {
    original: resolvedUrl.originalUrl,
  });
}

function extractTitle(value: unknown): string | undefined {
  const record = asRecord(value);
  const title = record ? record['title'] : undefined;
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
  const finalUrl = cached.url !== normalizedUrl ? cached.url : undefined;

  return {
    data,
    fromCache: true,
    url: normalizedUrl,
    ...(finalUrl ? { finalUrl } : {}),
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
    if (cachedResult) {
      return { ...cachedResult, originalUrl: resolvedUrl.originalUrl };
    }
  }

  logDebug('Fetching URL', { url: resolvedUrl.normalizedUrl });

  const { buffer, encoding, truncated, finalUrl } =
    await fetchNormalizedUrlBuffer(
      resolvedUrl.normalizedUrl,
      withSignal(options.signal)
    );
  const transformUrl = finalUrl || resolvedUrl.normalizedUrl;
  const data = await options.transform(
    { buffer, encoding, ...(truncated ? { truncated: true } : {}) },
    transformUrl
  );

  if (cache.isEnabled()) {
    persistCache({
      cacheKey,
      data,
      serialize: options.serialize,
      normalizedUrl: finalUrl || resolvedUrl.normalizedUrl,
      cacheNamespace: options.cacheNamespace,
    });

    if (finalUrl && finalUrl !== resolvedUrl.normalizedUrl) {
      const finalCacheKey = cache.createCacheKey(
        options.cacheNamespace,
        finalUrl,
        options.cacheVary
      );
      if (finalCacheKey && finalCacheKey !== cacheKey) {
        persistCache({
          cacheKey: finalCacheKey,
          data,
          serialize: options.serialize,
          normalizedUrl: finalUrl,
          cacheNamespace: options.cacheNamespace,
        });
      }
    }
  }

  return {
    data,
    fromCache: false,
    url: resolvedUrl.normalizedUrl,
    originalUrl: resolvedUrl.originalUrl,
    finalUrl,
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
  readonly maxInlineChars?: number;
  readonly transform: (
    input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
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
    options.maxInlineChars
  );

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
  const errorContent = {
    error: message,
    url,
    ...(extra?.statusCode !== undefined
      ? { statusCode: extra.statusCode }
      : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };

  return {
    content: [buildTextBlock(errorContent)],
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

function normalizeExtractedMetadata(
  metadata:
    | {
        title?: string | undefined;
        description?: string | undefined;
        author?: string | undefined;
        image?: string | undefined;
        favicon?: string | undefined;
        publishedAt?: string | undefined;
        modifiedAt?: string | undefined;
      }
    | undefined
): MarkdownPipelineResult['metadata'] | undefined {
  if (!metadata) return undefined;

  const normalized = {
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    ...(metadata.image ? { image: metadata.image } : {}),
    ...(metadata.favicon ? { favicon: metadata.favicon } : {}),
    ...(metadata.publishedAt ? { publishedAt: metadata.publishedAt } : {}),
    ...(metadata.modifiedAt ? { modifiedAt: metadata.modifiedAt } : {}),
  };

  if (Object.keys(normalized).length === 0) return undefined;
  return normalized;
}

const cachedMarkdownSchema = z
  .object({
    markdown: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
    metadata: z
      .strictObject({
        title: z.string().optional(),
        description: z.string().optional(),
        author: z.string().optional(),
        image: z.string().optional(),
        favicon: z.string().optional(),
        publishedAt: z.string().optional(),
        modifiedAt: z.string().optional(),
      })
      .optional(),
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

  const metadata = normalizeExtractedMetadata(result.data.metadata);

  const truncated = result.data.truncated ?? false;
  const persistedMarkdown = truncated
    ? appendTruncationMarker(markdown, TRUNCATION_MARKER)
    : markdown;

  return {
    content: persistedMarkdown,
    markdown: persistedMarkdown,
    title: result.data.title,
    ...(metadata ? { metadata } : {}),
    truncated,
  };
}

const markdownTransform = async (
  input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
  url: string,
  signal?: AbortSignal,
  skipNoiseRemoval?: boolean
): Promise<MarkdownPipelineResult> => {
  const result = await transformBufferToMarkdown(input.buffer, url, {
    includeMetadata: true,
    encoding: input.encoding,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    ...(input.truncated ? { inputTruncated: true } : {}),
  });
  const truncated = Boolean(result.truncated || input.truncated);
  return { ...result, content: result.markdown, truncated };
};

function serializeMarkdownResult(result: MarkdownPipelineResult): string {
  const persistedMarkdown = result.truncated
    ? appendTruncationMarker(result.markdown, TRUNCATION_MARKER)
    : result.markdown;

  return JSON.stringify({
    markdown: persistedMarkdown,
    title: result.title,
    metadata: result.metadata,
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
  const cacheResourceUri = resolveCacheResourceUri(pipeline.cacheKey);
  const truncated = inlineResult.truncated ?? pipeline.data.truncated;
  const markdown = applyTruncationMarker(
    inlineResult.content,
    pipeline.data.truncated
  );
  const { metadata } = pipeline.data;

  return {
    url: pipeline.originalUrl ?? pipeline.url,
    resolvedUrl: pipeline.url,
    ...(pipeline.finalUrl ? { finalUrl: pipeline.finalUrl } : {}),
    ...(cacheResourceUri ? { cacheResourceUri } : {}),
    inputUrl,
    title: pipeline.data.title,
    ...(metadata ? { metadata } : {}),
    markdown,
    fromCache: pipeline.fromCache,
    fetchedAt: pipeline.fetchedAt,
    contentSize: inlineResult.contentSize,
    ...(truncated ? { truncated: true } : {}),
  };
}

function applyTruncationMarker(
  content: string | undefined,
  truncated: boolean
): string | undefined {
  if (!truncated || typeof content !== 'string') return content;
  return appendTruncationMarker(content, TRUNCATION_MARKER);
}

function resolveCacheResourceUri(
  cacheKey: string | null | undefined
): string | undefined {
  if (!cacheKey) return undefined;
  if (!cache.isEnabled()) return undefined;
  if (!cache.get(cacheKey)) return undefined;

  const parsed = cache.parseCacheKey(cacheKey);
  if (!parsed) return undefined;

  return `internal://cache/${encodeURIComponent(parsed.namespace)}/${encodeURIComponent(parsed.urlHash)}`;
}

function buildFetchUrlContentBlocks(
  structuredContent: Record<string, unknown>,
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): ToolContentBlockUnion[] {
  const cacheResourceUri = readString(structuredContent, 'cacheResourceUri');
  const contentToEmbed = config.runtime.httpMode
    ? inlineResult.content
    : pipeline.data.content;

  const resourceLink = cacheResourceUri
    ? buildCacheResourceLink(
        cacheResourceUri,
        inlineResult.contentSize,
        pipeline.fetchedAt
      )
    : null;

  const embedded =
    contentToEmbed && pipeline.url
      ? buildEmbeddedResource(contentToEmbed, pipeline.url, pipeline.data.title)
      : null;

  return buildToolContentBlocks(structuredContent, resourceLink, embedded);
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

  // Runtime validation guard: verify output matches schema
  const validation = fetchUrlOutputSchema.safeParse(structuredContent);
  if (!validation.success) {
    logWarn('Tool output schema validation failed', {
      url: inputUrl,
      issues: validation.error.issues,
    });
  }

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
  forceRefresh?: boolean,
  maxInlineChars?: number
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<MarkdownPipelineResult>({
    url,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { cacheVary: { skipNoiseRemoval: true } } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    ...(maxInlineChars !== undefined ? { maxInlineChars } : {}),
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      if (progress) {
        const contextStr = URL.canParse(url)
          ? new URL(url).hostname
          : 'unknown';
        void progress.report(2, `fetch-url: ${contextStr} [transforming]`);
      }
      return markdownTransform(
        { buffer, encoding, ...(truncated ? { truncated } : {}) },
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

  const contextStr = URL.canParse(url) ? new URL(url).hostname : 'unknown';
  void progress.report(0, `fetch-url: ${contextStr} [starting]`);
  logDebug('Fetching URL', { url });

  try {
    void progress.report(1, `fetch-url: ${contextStr} [fetching]`);
    const { pipeline, inlineResult } = await fetchPipeline(
      url,
      signal,
      progress,
      input.skipNoiseRemoval,
      input.forceRefresh,
      input.maxInlineChars
    );

    if (pipeline.fromCache) {
      void progress.report(3, `fetch-url: ${contextStr} [using cache]`);
    }

    void progress.report(4, `fetch-url: ${contextStr} [success]`);
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    void progress.report(
      4,
      `fetch-url: ${contextStr} [${isAbort ? 'cancelled' : 'failed'}]`
    );
    throw error;
  }
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

  const registeredTool = server.registerTool(
    TOOL_DEFINITION.name,
    {
      title: TOOL_DEFINITION.title,
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      outputSchema: TOOL_DEFINITION.outputSchema,
      annotations: TOOL_DEFINITION.annotations,
      execution: TOOL_DEFINITION.execution,
      icons: [TOOL_ICON],
    } as { inputSchema: typeof fetchUrlInputSchema } & Record<string, unknown>,
    withRequestContextIfMissing(TOOL_DEFINITION.handler)
  );
  registeredTool.execution = TOOL_DEFINITION.execution;
}
