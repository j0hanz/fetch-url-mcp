import { z } from 'zod';

import {
  type CachedPayload,
  cachedPayloadValueSchema,
  extractedMetadataSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
  parseCachedPayload,
  stringifyCachedPayload,
} from '../schemas.js';
import { transformBufferToMarkdown } from '../transform/transform.js';
import { type MarkdownTransformResult } from '../transform/types.js';
import { createCacheKey, get, isEnabled, set } from './cache.js';
import { toCacheScopeId } from './cache.js';
import { config, getSessionId, logDebug, logError, logWarn } from './core.js';
import {
  fetchNormalizedUrlBuffer,
  normalizeUrl,
  transformToRawUrl,
} from './http.js';
import { getErrorMessage, isObject, withSignal } from './utils.js';

export { withSignal };

const TRUNCATION_MARKER = '...[truncated]';
export interface InlineContentResult {
  content?: string;
  contentSize: number;
  truncated?: boolean;
}
interface FetchTransformInput {
  buffer: Uint8Array;
  encoding: string;
  truncated?: boolean;
}

function getOpenCodeFence(
  content: string
): { fenceChar: string; fenceLength: number } | null {
  const FENCE_PATTERN = /^[ \t]*(`{3,}|~{3,})([^\S\r\n]*|[^\r\n]*)$/gm;
  let inFence = false;
  let fenceChar: string | null = null;
  let fenceLength = 0;

  for (const match of content.matchAll(FENCE_PATTERN)) {
    const marker = match[1] ?? '';
    const suffix = match[2] ?? '';
    const char = marker[0] ?? '';
    const { length } = marker;

    if (!inFence) {
      inFence = true;
      fenceChar = char;
      fenceLength = length;
      continue;
    }

    const isClosingFence =
      char === fenceChar && length >= fenceLength && suffix.trim().length === 0;

    if (isClosingFence) {
      inFence = false;
      fenceChar = null;
      fenceLength = 0;
    }
  }

  return inFence && fenceChar ? { fenceChar, fenceLength } : null;
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
    return `${content.substring(0, adjustedLength)}${fenceCloser}${marker}`.slice(
      0,
      limit
    );
  }

  const safeBoundary = findSafeLinkBoundary(content, maxContentLength);
  return `${content.substring(0, safeBoundary)}${marker}`.slice(0, limit);
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

  return `${contentWithFence.substring(0, safeBoundary)}${marker}`;
}

function normalizeMarkdownForTruncation(
  markdown: string,
  truncated: boolean
): string {
  return truncated
    ? appendTruncationMarker(markdown, TRUNCATION_MARKER)
    : markdown;
}

export function finalizeInlineMarkdown(
  markdown: string | undefined,
  options: { maxChars?: number } = {}
): string | undefined {
  if (markdown === undefined) return undefined;

  const maxChars = options.maxChars ?? 0;

  return maxChars > 0 && markdown.length > maxChars
    ? truncateWithMarker(markdown, maxChars, TRUNCATION_MARKER)
    : markdown;
}

function applyInlineContentLimit(
  content: string,
  truncated = false
): InlineContentResult {
  const normalized = normalizeMarkdownForTruncation(content, truncated);
  const contentSize = normalized.length;
  const inlineLimit = config.constants.maxInlineContentChars;

  if (inlineLimit <= 0 || contentSize <= inlineLimit) {
    return {
      content: normalized,
      contentSize,
      ...(truncated ? { truncated } : {}),
    };
  }

  return {
    content: truncateWithMarker(normalized, inlineLimit, TRUNCATION_MARKER),
    contentSize,
    truncated: true,
  };
}

interface FetchPipelineOptions<T> {
  url: string;
  cacheNamespace: string;
  signal?: AbortSignal;
  cacheVary?: Record<string, unknown> | string;
  forceRefresh?: boolean;
  onStage?: (stage: SharedFetchStage) => void;
  transform: (input: FetchTransformInput, url: string) => T | Promise<T>;
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
export type SharedFetchStage =
  | 'resolve_url'
  | 'check_cache'
  | 'cache_hit'
  | 'cache_restore'
  | 'fetch_remote'
  | 'response_ready'
  | 'transform_start'
  | 'prepare_output'
  | 'finalize_output';
interface UrlResolution {
  normalizedUrl: string;
  originalUrl: string;
  transformed: boolean;
}

function resolveNormalizedUrl(url: string): UrlResolution {
  const { normalizedUrl: validatedUrl } = normalizeUrl(url);
  const transformedResult = transformToRawUrl(validatedUrl);

  return {
    normalizedUrl: transformedResult.transformed
      ? normalizeUrl(transformedResult.url).normalizedUrl
      : validatedUrl,
    originalUrl: validatedUrl,
    transformed: transformedResult.transformed,
  };
}
function logCacheMiss(
  reason: string,
  cacheNamespace: string,
  normalizedUrl: string,
  error?: unknown
): void {
  // Deserialize exceptions indicate data corruption or schema drift —
  // use logError so they surface in monitoring, not just debug logs.
  const log =
    reason === 'deserialize exception'
      ? logError
      : reason.startsWith('deserialize')
        ? logWarn
        : logDebug;
  log(`Cache miss due to ${reason}`, {
    namespace: cacheNamespace,
    url: normalizedUrl,
    ...(error ? { error: getErrorMessage(error) } : {}),
  });
}
function attemptCacheRetrieval<T>(
  cacheKey: string | null,
  deserialize: ((cached: string) => T | undefined) | undefined,
  cacheNamespace: string,
  normalizedUrl: string
): PipelineResult<T> | null {
  if (!cacheKey) return null;

  const cached = get(cacheKey, { scopeId: toCacheScopeId(getSessionId()) });
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

function restoreCachedPipelineResult<T>(
  options: FetchPipelineOptions<T>,
  resolvedUrl: UrlResolution,
  cacheKey: string | null
): PipelineResult<T> | null {
  if (options.forceRefresh) return null;

  options.onStage?.('check_cache');
  const cachedResult = attemptCacheRetrieval(
    cacheKey,
    options.deserialize,
    options.cacheNamespace,
    resolvedUrl.normalizedUrl
  );
  if (!cachedResult) return null;

  options.onStage?.('cache_hit');
  options.onStage?.('cache_restore');
  return { ...cachedResult, originalUrl: resolvedUrl.originalUrl };
}

function persistCacheEntry<T>(
  cacheKey: string,
  data: T,
  serialize: ((result: T) => string) | undefined,
  normalizedUrl: string,
  cacheNamespace: string
): void {
  const serializer = serialize ?? JSON.stringify;
  const dataRecord = isObject(data) ? data : undefined;
  const title =
    typeof dataRecord?.['title'] === 'string' ? dataRecord['title'] : undefined;
  const metadata = {
    url: normalizedUrl,
    scopeIds: [toCacheScopeId(getSessionId())],
    ...(title === undefined ? {} : { title }),
  };

  try {
    set(cacheKey, serializer(data), metadata);
  } catch (error: unknown) {
    logWarn('Failed to persist cache entry', {
      namespace: cacheNamespace,
      url: normalizedUrl,
      error: getErrorMessage(error),
    });
  }
}
function persistCacheTargets<T>(
  requestedUrl: string,
  finalUrl: string | undefined,
  cacheKey: string | null,
  data: T,
  options: FetchPipelineOptions<T>
): void {
  if (!cacheKey) return;

  const targets = new Map<string, string>();
  targets.set(cacheKey, finalUrl ?? requestedUrl);

  if (finalUrl && finalUrl !== requestedUrl) {
    const finalCacheKey = createCacheKey(
      options.cacheNamespace,
      finalUrl,
      options.cacheVary
    );
    if (finalCacheKey) {
      targets.set(finalCacheKey, finalUrl);
    }
  }

  for (const [key, url] of targets) {
    persistCacheEntry(
      key,
      data,
      options.serialize,
      url,
      options.cacheNamespace
    );
  }
}

export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  options.onStage?.('resolve_url');
  const resolvedUrl = resolveNormalizedUrl(options.url);
  if (resolvedUrl.transformed) {
    logDebug('Using transformed raw content URL', {
      original: resolvedUrl.originalUrl,
    });
  }

  const cacheKey = createCacheKey(
    options.cacheNamespace,
    resolvedUrl.normalizedUrl,
    options.cacheVary
  );

  const cachedResult = restoreCachedPipelineResult(
    options,
    resolvedUrl,
    cacheKey
  );
  if (cachedResult) return cachedResult;

  options.onStage?.('fetch_remote');
  logDebug('Fetching URL', { url: resolvedUrl.normalizedUrl });

  const { buffer, encoding, truncated, finalUrl } =
    await fetchNormalizedUrlBuffer(
      resolvedUrl.normalizedUrl,
      withSignal(options.signal)
    );

  options.onStage?.('response_ready');
  options.onStage?.('transform_start');

  const resolvedFinalUrl = finalUrl || resolvedUrl.normalizedUrl;
  const data = await options.transform(
    { buffer, encoding, ...(truncated ? { truncated: true } : {}) },
    resolvedFinalUrl
  );

  if (isEnabled()) {
    persistCacheTargets(
      resolvedUrl.normalizedUrl,
      finalUrl,
      cacheKey,
      data,
      options
    );
  }

  return {
    data,
    fromCache: false,
    url: resolvedUrl.normalizedUrl,
    originalUrl: resolvedUrl.originalUrl,
    ...(finalUrl ? { finalUrl } : {}),
    fetchedAt: new Date().toISOString(),
    cacheKey,
  };
}

export type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

const markdownPipelineResultSchema = z.strictObject({
  markdown: z.string(),
  content: z.string(),
  title: z.union([z.string(), z.undefined()]),
  metadata: extractedMetadataSchema.optional(),
  truncated: z.boolean(),
});

function createMarkdownPipelineResult({
  markdown: rawMarkdown,
  title,
  metadata,
  truncated,
}: {
  markdown: string;
  title: string | undefined;
  metadata: ReturnType<typeof normalizeExtractedMetadata>;
  truncated: boolean;
}): MarkdownPipelineResult {
  const markdown = normalizeMarkdownForTruncation(rawMarkdown, truncated);

  return {
    content: markdown,
    markdown,
    title,
    ...(metadata ? { metadata } : {}),
    truncated,
  };
}

const markdownPipelineCacheCodec = z.codec(
  cachedPayloadValueSchema,
  markdownPipelineResultSchema,
  {
    decode: (payload) =>
      createMarkdownPipelineResult({
        markdown: payload.markdown,
        title: payload.title,
        metadata: payload.metadata,
        truncated: payload.truncated ?? false,
      }),
    encode: (result): CachedPayload => {
      const title = normalizePageTitle(result.title);
      const metadata = normalizeExtractedMetadata(result.metadata);

      return {
        markdown: normalizeMarkdownForTruncation(
          result.markdown,
          result.truncated
        ),
        ...(title !== undefined ? { title } : {}),
        ...(metadata ? { metadata } : {}),
        truncated: result.truncated,
      };
    },
  }
);

export function parseCachedMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  const payload = parseCachedPayload(cached);
  if (!payload) return undefined;

  return z.decode(markdownPipelineCacheCodec, payload);
}

export const markdownTransform = async (
  input: FetchTransformInput,
  url: string,
  signal?: AbortSignal
): Promise<MarkdownPipelineResult> => {
  const result = await transformBufferToMarkdown(input.buffer, url, {
    includeMetadata: true,
    encoding: input.encoding,
    ...withSignal(signal),
    ...(input.truncated ? { inputTruncated: true } : {}),
  });

  return createMarkdownPipelineResult({
    markdown: result.markdown,
    title: result.title,
    metadata: result.metadata,
    truncated: Boolean(result.truncated || input.truncated),
  });
};

export function serializeMarkdownResult(
  result: MarkdownPipelineResult
): string {
  return stringifyCachedPayload(z.encode(markdownPipelineCacheCodec, result));
}

interface MarkdownFetchOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly cacheVary?: Record<string, unknown> | string;
  readonly forceRefresh?: boolean;
  readonly onStage?: (stage: SharedFetchStage) => void;
  readonly transform: (
    input: FetchTransformInput,
    normalizedUrl: string
  ) => MarkdownPipelineResult | Promise<MarkdownPipelineResult>;
  readonly serialize?: (result: MarkdownPipelineResult) => string;
  readonly deserialize?: (cached: string) => MarkdownPipelineResult | undefined;
}
interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}
function buildSharedFetchPipelineOptions(
  options: MarkdownFetchOptions
): FetchPipelineOptions<MarkdownPipelineResult> {
  return {
    ...options,
    cacheNamespace: 'markdown',
  };
}
export async function performSharedFetch(
  options: MarkdownFetchOptions,
  deps: SharedFetchDeps = {}
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineContentResult;
}> {
  const executePipeline = deps.executeFetchPipeline ?? executeFetchPipeline;
  const pipeline = await executePipeline(
    buildSharedFetchPipelineOptions(options)
  );
  options.onStage?.('prepare_output');
  options.onStage?.('finalize_output');
  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.data.truncated
  );

  return { pipeline, inlineResult };
}
