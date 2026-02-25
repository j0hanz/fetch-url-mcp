import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  TextResourceContents,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import * as cache from './cache.js';
import { config } from './config.js';
import { generateSafeFilename } from './download.js';
import {
  getRequestId,
  logDebug,
  logError,
  logWarn,
  runWithRequestContext,
} from './observability.js';
import { createToolErrorResponse, handleToolError } from './tool-errors.js';
import {
  appendTruncationMarker,
  type InlineContentResult,
  type MarkdownPipelineResult,
  markdownTransform,
  parseCachedMarkdownResult,
  performSharedFetch,
  type PipelineResult,
  readNestedRecord,
  readString,
  serializeMarkdownResult,
  TRUNCATION_MARKER,
  withSignal,
} from './tool-pipeline.js';
import {
  createProgressReporter,
  type ProgressReporter,
  type ToolHandlerExtra,
} from './tool-progress.js';
import { isObject } from './type-guards.js';

// Re-export public API so existing consumers keep working.
export { createToolErrorResponse, handleToolError } from './tool-errors.js';
export {
  executeFetchPipeline,
  parseCachedMarkdownResult,
  performSharedFetch,
} from './tool-pipeline.js';
export {
  createProgressReporter,
  type ProgressNotification,
  type ProgressNotificationParams,
} from './tool-progress.js';

export interface FetchUrlInput {
  url: string;
  skipNoiseRemoval?: boolean | undefined;
  forceRefresh?: boolean | undefined;
  maxInlineChars?: number | undefined;
}

type ToolContentBlockUnion = ContentBlock;
type ToolOutputBlock = ToolContentBlockUnion;

interface ToolResponseBase {
  [key: string]: unknown;
  content: ToolContentBlockUnion[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean;
}

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

Key behaviors:
- GitHub, GitLab, and Bitbucket URLs are auto-transformed to raw content endpoints; check resolvedUrl.
- If truncated is true in the response, use cacheResourceUri with resources/read to retrieve the full content.
- For long-running fetches or large pages, invoke with task: {} to get a taskId and poll tasks/get until complete.

Limitations:
- Does not execute client-side JavaScript; JS-rendered pages may be incomplete.
- If the error code is queue_full, the worker pool is busy — retry the call using task mode (task: {}) instead.
`.trim();

const TOOL_ICON = {
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPg==',
  mimeType: 'image/svg+xml',
};

/* -------------------------------------------------------------------------------------------------
 * Tool response builders
 * ------------------------------------------------------------------------------------------------- */

function buildTextBlock(structuredContent: Record<string, unknown>): {
  type: 'text';
  text: string;
} {
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

  const filename = generateSafeFilename(url, title, undefined, '.md');
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
): ToolOutputBlock {
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

  appendIfPresent(blocks, resourceLink);
  appendIfPresent(blocks, embeddedResource);

  return blocks;
}

function appendIfPresent<T>(items: T[], value: T | null | undefined): void {
  if (value !== null && value !== undefined) items.push(value);
}

/* -------------------------------------------------------------------------------------------------
 * Tool abort signal
 * ------------------------------------------------------------------------------------------------- */

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
 * Structured response assembly
 * ------------------------------------------------------------------------------------------------- */

function truncateStr(
  value: string | undefined,
  max: number
): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return value.slice(0, max);
}

function truncateMetadata(metadata: {
  title?: string;
  description?: string;
  author?: string;
  image?: string;
  favicon?: string;
  publishedAt?: string;
  modifiedAt?: string;
}): Record<string, unknown> {
  return {
    ...metadata,
    ...(metadata.title !== undefined
      ? { title: truncateStr(metadata.title, 512) }
      : {}),
    ...(metadata.description !== undefined
      ? { description: truncateStr(metadata.description, 2048) }
      : {}),
    ...(metadata.author !== undefined
      ? { author: truncateStr(metadata.author, 512) }
      : {}),
  };
}

function buildStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineContentResult,
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
    title: truncateStr(pipeline.data.title, 512),
    ...(metadata ? { metadata: truncateMetadata(metadata) } : {}),
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
  inlineResult: InlineContentResult
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
  inlineResult: InlineContentResult,
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

  const validation = fetchUrlOutputSchema.safeParse(structuredContent);
  if (!validation.success) {
    logWarn('Tool output schema validation failed', {
      url: inputUrl,
      issues: validation.error.issues,
    });
    // Omit structuredContent so the SDK does not receive data that fails its
    // output schema validation. The client still gets the payload via content[0].text.
    return { content };
  }

  return {
    content,
    structuredContent,
  };
}

/* -------------------------------------------------------------------------------------------------
 * fetch-url tool implementation
 * ------------------------------------------------------------------------------------------------- */

export function getUrlContext(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (path === '/' || path === '') return host;
    let basename = path.split('/').filter(Boolean).pop();
    if (basename && basename.length > 20) {
      basename = `${basename.substring(0, 17)}...`;
    }
    return basename ? `${host}/…/${basename}` : host;
  } catch {
    return 'unknown';
  }
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
  inlineResult: InlineContentResult;
}> {
  return performSharedFetch({
    url,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { cacheVary: { skipNoiseRemoval: true } } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    ...(maxInlineChars !== undefined ? { maxInlineChars } : {}),
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      if (progress) {
        const contextStr = getUrlContext(url);
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

  const contextStr = getUrlContext(url);
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

    void progress.report(4, `fetch-url: ${contextStr} • success`);
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    void progress.report(
      4,
      `fetch-url: ${contextStr} • ${isAbort ? 'cancelled' : 'failed'}`
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
  // SDK workaround: RegisteredTool does not expose `execution` in its public type, so we
  // assign it directly post-registration to enable task-augmented tool calls (taskSupport).
  registeredTool.execution = TOOL_DEFINITION.execution;
}
