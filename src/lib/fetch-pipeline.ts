import {
  type CachedPayload,
  normalizeExtractedMetadata,
  parseCachedPayload,
} from '../schemas.js';
import { transformBufferToMarkdown } from '../transform/transform.js';
import { type MarkdownTransformResult } from '../transform/types.js';
import {
  config,
  createCacheKey,
  get,
  isEnabled,
  logDebug,
  logWarn,
  set,
} from './core.js';
import {
  fetchNormalizedUrlBuffer,
  normalizeUrl,
  transformToRawUrl,
} from './http.js';
import {
  getErrorMessage,
  readNestedRecord,
  readString,
  withSignal,
} from './utils.js';

export { readNestedRecord, withSignal };

export const TRUNCATION_MARKER = '...[truncated]';
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
  options: { truncated?: boolean; maxChars?: number } = {}
): string | undefined {
  if (markdown === undefined) return undefined;

  const normalized = normalizeMarkdownForTruncation(
    markdown,
    options.truncated ?? false
  );
  const maxChars = options.maxChars ?? 0;

  return maxChars > 0 && normalized.length > maxChars
    ? normalized.slice(0, maxChars)
    : normalized;
}

function applyInlineContentLimit(content: string): InlineContentResult {
  const contentSize = content.length;
  const inlineLimit = config.constants.maxInlineContentChars;

  if (inlineLimit <= 0 || contentSize <= inlineLimit) {
    return { content, contentSize };
  }

  return {
    content: truncateWithMarker(content, inlineLimit, TRUNCATION_MARKER),
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
function attemptCacheRetrieval<T>(
  cacheKey: string | null,
  deserialize: ((cached: string) => T | undefined) | undefined,
  cacheNamespace: string,
  normalizedUrl: string
): PipelineResult<T> | null {
  if (!cacheKey) return null;

  const cached = get(cacheKey);
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
  const title = readString(data, 'title');
  const metadata = {
    url: normalizedUrl,
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
function persistAllCacheTargets<T>(
  primaryCacheKey: string | null,
  data: T,
  serialize: ((result: T) => string) | undefined,
  cacheNamespace: string,
  cacheVary: Record<string, unknown> | string | undefined,
  requestedUrl: string,
  finalUrl: string | undefined
): void {
  if (primaryCacheKey) {
    persistCacheEntry(
      primaryCacheKey,
      data,
      serialize,
      finalUrl ?? requestedUrl,
      cacheNamespace
    );
  }

  if (!finalUrl || finalUrl === requestedUrl) return;

  const finalCacheKey = createCacheKey(cacheNamespace, finalUrl, cacheVary);
  if (!finalCacheKey || finalCacheKey === primaryCacheKey) return;

  persistCacheEntry(finalCacheKey, data, serialize, finalUrl, cacheNamespace);
}

function createTransformInput(
  buffer: Uint8Array,
  encoding: string,
  truncated?: boolean
): FetchTransformInput {
  return {
    buffer,
    encoding,
    ...(truncated ? { truncated: true } : {}),
  };
}

async function fetchRemotePipelineData<T>(
  options: FetchPipelineOptions<T>,
  normalizedUrl: string
): Promise<{ data: T; finalUrl?: string }> {
  options.onStage?.('fetch_remote');
  logDebug('Fetching URL', { url: normalizedUrl });

  const { buffer, encoding, truncated, finalUrl } =
    await fetchNormalizedUrlBuffer(normalizedUrl, withSignal(options.signal));

  options.onStage?.('response_ready');
  options.onStage?.('transform_start');

  const resolvedFinalUrl = finalUrl || normalizedUrl;
  const data = await options.transform(
    createTransformInput(buffer, encoding, truncated),
    resolvedFinalUrl
  );

  return { data, finalUrl };
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

  const { data, finalUrl } = await fetchRemotePipelineData(
    options,
    resolvedUrl.normalizedUrl
  );

  if (isEnabled()) {
    persistAllCacheTargets(
      cacheKey,
      data,
      options.serialize,
      options.cacheNamespace,
      options.cacheVary,
      resolvedUrl.normalizedUrl,
      finalUrl
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

function createMarkdownPipelineResult(params: {
  markdown: string;
  title: string | undefined;
  metadata: ReturnType<typeof normalizeExtractedMetadata>;
  truncated: boolean;
}): MarkdownPipelineResult {
  const markdown = normalizeMarkdownForTruncation(
    params.markdown,
    params.truncated
  );

  return {
    content: markdown,
    markdown,
    title: params.title,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    truncated: params.truncated,
  };
}

export function parseCachedMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  const payload = parseCachedPayload(cached);
  if (!payload) return undefined;

  const { markdown } = payload;
  if (typeof markdown !== 'string') return undefined;

  const metadata = normalizeExtractedMetadata(payload.metadata);
  return createMarkdownPipelineResult({
    markdown,
    title: payload.title,
    metadata,
    truncated: payload.truncated ?? false,
  });
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
  const payload: CachedPayload = {
    markdown: normalizeMarkdownForTruncation(result.markdown, result.truncated),
    title: result.title,
    metadata: result.metadata,
    truncated: result.truncated,
  };

  return JSON.stringify(payload);
}

interface SharedFetchOptions {
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
  options: SharedFetchOptions
): FetchPipelineOptions<MarkdownPipelineResult> {
  const opts: FetchPipelineOptions<MarkdownPipelineResult> = {
    url: options.url,
    cacheNamespace: 'markdown',
    transform: options.transform,
  };
  if (options.signal !== undefined) opts.signal = options.signal;
  if (options.cacheVary !== undefined) opts.cacheVary = options.cacheVary;
  if (options.forceRefresh) opts.forceRefresh = true;
  if (options.onStage) opts.onStage = options.onStage;
  if (options.serialize) opts.serialize = options.serialize;
  if (options.deserialize) opts.deserialize = options.deserialize;
  return opts;
}
export async function performSharedFetch(
  options: SharedFetchOptions,
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
  const inlineResult = applyInlineContentLimit(pipeline.data.content);

  return { pipeline, inlineResult };
}
