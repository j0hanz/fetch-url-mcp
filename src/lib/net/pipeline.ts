import type { normalizeExtractedMetadata } from '../../schemas.js';
import {
  type MarkdownTransformResult,
  transformBufferToMarkdown,
} from '../../transform/index.js';
import { config, logDebug } from '../core.js';
import { Loggers } from '../logger-names.js';
import { withSignal } from '../utils.js';
import {
  fetchNormalizedUrlBuffer,
  normalizeUrl,
  transformToRawUrl,
} from './http.js';

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
  signal?: AbortSignal;
  onStage?: (stage: SharedFetchStage) => void;
  transform: (input: FetchTransformInput, url: string) => T | Promise<T>;
}
export interface PipelineResult<T> {
  data: T;
  url: string;
  originalUrl?: string;
  finalUrl?: string;
  fetchedAt: string;
}
export type SharedFetchStage =
  | 'resolve_url'
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
export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  options.onStage?.('resolve_url');
  const resolvedUrl = resolveNormalizedUrl(options.url);
  if (resolvedUrl.transformed) {
    logDebug(
      'Using transformed raw content URL',
      {
        original: resolvedUrl.originalUrl,
      },
      Loggers.LOG_FETCH
    );
  }

  options.onStage?.('fetch_remote');
  logDebug(
    'Fetching URL',
    { url: resolvedUrl.normalizedUrl },
    Loggers.LOG_FETCH
  );

  const { buffer, encoding, truncated, finalUrl } =
    await fetchNormalizedUrlBuffer(
      resolvedUrl.normalizedUrl,
      withSignal(options.signal)
    );

  if (finalUrl && finalUrl !== resolvedUrl.normalizedUrl) {
    logDebug(
      'Fetch redirected',
      {
        fromUrl: resolvedUrl.normalizedUrl,
        toUrl: finalUrl,
      },
      Loggers.LOG_FETCH
    );
  }

  options.onStage?.('response_ready');
  options.onStage?.('transform_start');

  const resolvedFinalUrl = finalUrl || resolvedUrl.normalizedUrl;
  const data = await options.transform(
    { buffer, encoding, ...(truncated ? { truncated: true } : {}) },
    resolvedFinalUrl
  );

  return {
    data,
    url: resolvedUrl.normalizedUrl,
    originalUrl: resolvedUrl.originalUrl,
    ...(finalUrl ? { finalUrl } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

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

export const markdownTransform = async (
  input: FetchTransformInput,
  url: string,
  signal?: AbortSignal
): Promise<MarkdownPipelineResult> => {
  const result = await transformBufferToMarkdown(input.buffer, url, {
    includeMetadataFooter: true,
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

interface MarkdownFetchOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: SharedFetchStage) => void;
  readonly transform: (
    input: FetchTransformInput,
    normalizedUrl: string
  ) => MarkdownPipelineResult | Promise<MarkdownPipelineResult>;
}
interface SharedFetchDeps {
  readonly executeFetchPipeline?: typeof executeFetchPipeline;
}
function buildSharedFetchPipelineOptions(
  options: MarkdownFetchOptions
): FetchPipelineOptions<MarkdownPipelineResult> {
  return { ...options };
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

  if (inlineResult.truncated) {
    logDebug(
      'Inline markdown truncated for response payload',
      {
        url: pipeline.finalUrl ?? pipeline.url,
        contentSize: inlineResult.contentSize,
        maxInlineChars: config.constants.maxInlineContentChars,
      },
      Loggers.LOG_FETCH
    );
  }

  return { pipeline, inlineResult };
}
