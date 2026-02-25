import { z } from 'zod';

import * as cache from './cache.js';
import { transformBufferToMarkdown } from '../transform/transform.js';
import type { MarkdownTransformResult } from '../transform/types.js';
import { config } from './config.js';
import { getErrorMessage } from './errors.js';
import {
  fetchNormalizedUrlBuffer,
  normalizeUrl,
  transformToRawUrl,
} from './fetch.js';
import { logDebug, logWarn } from './observability.js';
import { isObject } from './type-guards.js';

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

export function readString(obj: unknown, key: string): string | undefined {
  const value = readUnknown(obj, key);
  return typeof value === 'string' ? value : undefined;
}

export function readNestedRecord(
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

export function withSignal(
  signal?: AbortSignal
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}

/* -------------------------------------------------------------------------------------------------
 * Inline content limiting
 * ------------------------------------------------------------------------------------------------- */

export const TRUNCATION_MARKER = '...[truncated]';

export interface InlineContentResult {
  content?: string;
  contentSize: number;
  truncated?: boolean;
}

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
    return `${content.substring(0, safeBoundary)}${marker}`.slice(0, limit);
  }

  return `${tentativeContent}${marker}`.slice(0, limit);
}

export function appendTruncationMarker(
  content: string,
  marker: string
): string {
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

    if (isWithinInlineLimit(contentSize, inlineLimit)) {
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

    return inlineLimitOverride;
  }
}

function isWithinInlineLimit(
  contentSize: number,
  inlineLimit: number
): boolean {
  return inlineLimit <= 0 || contentSize <= inlineLimit;
}

const inlineLimiter = new InlineContentLimiter();

function applyInlineContentLimit(
  content: string,
  inlineLimitOverride?: number
): InlineContentResult {
  return inlineLimiter.apply(content, inlineLimitOverride);
}

/* -------------------------------------------------------------------------------------------------
 * Fetch pipeline types
 * ------------------------------------------------------------------------------------------------- */

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

export interface PipelineResult<T> {
  data: T;
  fromCache: boolean;
  url: string;
  originalUrl?: string;
  finalUrl?: string;
  fetchedAt: string;
  cacheKey?: string | null;
}

/* -------------------------------------------------------------------------------------------------
 * URL resolution
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

/* -------------------------------------------------------------------------------------------------
 * Cache helpers
 * ------------------------------------------------------------------------------------------------- */

function extractTitle(value: unknown): string | undefined {
  return readString(value, 'title');
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

function createCacheHitResult<T>(params: {
  data: T;
  normalizedUrl: string;
  cachedUrl: string;
  fetchedAt: string;
  cacheKey: string;
}): PipelineResult<T> {
  const finalUrl =
    params.cachedUrl !== params.normalizedUrl ? params.cachedUrl : undefined;

  return {
    data: params.data,
    fromCache: true,
    url: params.normalizedUrl,
    ...(finalUrl ? { finalUrl } : {}),
    fetchedAt: params.fetchedAt,
    cacheKey: params.cacheKey,
  };
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

  return createCacheHitResult({
    data,
    normalizedUrl,
    cachedUrl: cached.url,
    fetchedAt: cached.fetchedAt,
    cacheKey,
  });
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

/* -------------------------------------------------------------------------------------------------
 * Pipeline executor
 * ------------------------------------------------------------------------------------------------- */

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
  const resolvedFinalUrl = finalUrl || resolvedUrl.normalizedUrl;
  const transformUrl = resolvedFinalUrl;
  const data = await options.transform(
    { buffer, encoding, ...(truncated ? { truncated: true } : {}) },
    transformUrl
  );

  if (cache.isEnabled()) {
    persistCache({
      cacheKey,
      data,
      serialize: options.serialize,
      normalizedUrl: resolvedFinalUrl,
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
 * Markdown pipeline (transform + cache codec)
 * ------------------------------------------------------------------------------------------------- */

export type MarkdownPipelineResult = MarkdownTransformResult & {
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

  const normalized = Object.fromEntries(
    Object.entries(metadata).filter(([, v]) => Boolean(v))
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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

export const markdownTransform = async (
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

export function serializeMarkdownResult(
  result: MarkdownPipelineResult
): string {
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
 * Shared fetch helper
 * ------------------------------------------------------------------------------------------------- */

interface SharedFetchOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly cacheVary?: Record<string, unknown> | string;
  readonly forceRefresh?: boolean;
  readonly maxInlineChars?: number;
  readonly transform: (
    input: { buffer: Uint8Array; encoding: string; truncated?: boolean },
    normalizedUrl: string
  ) => MarkdownPipelineResult | Promise<MarkdownPipelineResult>;
  readonly serialize?: (result: MarkdownPipelineResult) => string;
  readonly deserialize?: (cached: string) => MarkdownPipelineResult | undefined;
}

interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}

export async function performSharedFetch(
  options: SharedFetchOptions,
  deps: SharedFetchDeps = {}
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineContentResult;
}> {
  const executePipeline = deps.executeFetchPipeline ?? executeFetchPipeline;

  const pipelineOptions: FetchPipelineOptions<MarkdownPipelineResult> = {
    url: options.url,
    cacheNamespace: 'markdown',
    ...withSignal(options.signal),
    ...(options.cacheVary ? { cacheVary: options.cacheVary } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    transform: options.transform,
    ...(options.serialize ? { serialize: options.serialize } : {}),
    ...(options.deserialize ? { deserialize: options.deserialize } : {}),
  };

  const pipeline = await executePipeline(pipelineOptions);
  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    options.maxInlineChars
  );

  return { pipeline, inlineResult };
}
