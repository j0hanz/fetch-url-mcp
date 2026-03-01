import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  TextResourceContents,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import * as cache from '../lib/core.js';
import { config } from '../lib/core.js';
import {
  getRequestId,
  logDebug,
  logError,
  logWarn,
  runWithRequestContext,
} from '../lib/core.js';
import { generateSafeFilename } from '../lib/http.js';
import { handleToolError } from '../lib/mcp-tools.js';
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
} from '../lib/mcp-tools.js';
import {
  createProgressReporter,
  type ProgressReporter,
  type ToolHandlerExtra,
} from '../lib/mcp-tools.js';
import { isAbortError, isObject, toError } from '../lib/utils.js';
import { fetchUrlInputSchema } from '../schemas/inputs.js';
import { fetchUrlOutputSchema } from '../schemas/outputs.js';
import {
  registerTaskCapableTool,
  unregisterTaskCapableTool,
} from '../tasks/tool-registry.js';
import type { ExtractedMetadata } from '../transform/types.js';

interface FetchUrlInput {
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

export const FETCH_URL_TOOL_NAME = 'fetch-url';
const FETCH_URL_TOOL_DESCRIPTION = `
<role>Web Content Extractor</role>
<task>Fetch public webpages and convert HTML to clean Markdown.</task>
<constraints>
- READ-ONLY. No JavaScript execution.
- GitHub/GitLab/Bitbucket URLs auto-transform to raw endpoints (check resolvedUrl).
- If truncated=true, use cacheResourceUri with resources/read for full content.
- For large pages/timeouts, use task mode (task: {}).
- If error queue_full, retry with task mode.
</constraints>
`.trim();

const TOOL_ICON = {
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPg==',
  mimeType: 'image/svg+xml',
};
const JSON_SCHEMA_DRAFT_2020_12_URI =
  'https://json-schema.org/draft/2020-12/schema';

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
  const uri = `internal://inline/${encodeURIComponent(filename)}`;

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

const HARD_TOOL_TIMEOUT_MS = 300_000;

function buildToolAbortSignal(
  extraSignal: AbortSignal | undefined
): AbortSignal | undefined {
  const { timeoutMs } = config.tools;
  const effectiveTimeout = timeoutMs > 0 ? timeoutMs : HARD_TOOL_TIMEOUT_MS;

  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
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

const METADATA_FIELD_LIMITS: Partial<Record<keyof ExtractedMetadata, number>> =
  {
    title: 512,
    description: 2048,
    author: 512,
  };

function truncateMetadata(metadata: ExtractedMetadata): ExtractedMetadata {
  const result = { ...metadata };
  for (const [field, limit] of Object.entries(METADATA_FIELD_LIMITS)) {
    const key = field as keyof ExtractedMetadata;
    const value = result[key];
    if (typeof value === 'string' && value.length > limit) {
      result[key] = value.slice(0, limit);
    }
  }
  return result;
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

function getUrlContext(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (path === '/' || path === '') return host;

    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return host;

    // Special case for GitHub/GitLab/Bitbucket
    if (
      host === 'github.com' ||
      host === 'gitlab.com' ||
      host === 'bitbucket.org'
    ) {
      if (parts.length >= 2) {
        const p0 = parts[0] ?? '';
        const p1 = parts[1] ?? '';
        return `${host}/${p0}/${p1}`;
      }
    }

    // Special case for Wikipedia
    if (
      host.endsWith('wikipedia.org') &&
      parts[0] === 'wiki' &&
      parts.length >= 2
    ) {
      const p1 = parts[1] ?? '';
      return `wikipedia.org/${p1}`;
    }

    let basename = parts.pop() ?? '';
    if (basename && basename.length > 20) {
      basename = `${basename.substring(0, 17)}...`;
    }

    if (parts.length === 0) {
      return `${host}/${basename}`;
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
  const contextStr = getUrlContext(url);

  return performSharedFetch({
    url,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { cacheVary: { skipNoiseRemoval: true } } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    ...(maxInlineChars !== undefined ? { maxInlineChars } : {}),
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      reportFetchProgress(progress, 2, contextStr, 'converting to Markdown');
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

function buildFetchProgressMessage(context: string, state: string): string {
  if (state === 'completed' || state === 'cancelled' || state === 'failed') {
    return `fetch-url: ${context} • ${state}`;
  }
  return `fetch-url: ${context} [${state}]`;
}

function reportFetchProgress(
  progress: ProgressReporter | undefined,
  step: number,
  context: string,
  state: string
): void {
  if (!progress) return;
  progress.report(step, buildFetchProgressMessage(context, state));
}

async function executeFetch(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  const { url } = input;
  const signal = buildToolAbortSignal(extra?.signal);
  const progress = createProgressReporter(extra);

  const contextStr = getUrlContext(url);
  reportFetchProgress(progress, 0, contextStr, 'starting');
  logDebug('Fetching URL', { url });

  try {
    reportFetchProgress(progress, 1, contextStr, 'fetching HTML');
    const { pipeline, inlineResult } = await fetchPipeline(
      url,
      signal,
      progress,
      input.skipNoiseRemoval,
      input.forceRefresh,
      input.maxInlineChars
    );

    if (pipeline.fromCache) {
      reportFetchProgress(progress, 3, contextStr, 'loaded from cache');
    }

    reportFetchProgress(progress, 4, contextStr, 'completed');
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    const isAbort = isAbortError(error);
    reportFetchProgress(
      progress,
      4,
      contextStr,
      isAbort ? 'cancelled' : 'failed'
    );
    throw error;
  }
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  return executeFetch(input, extra).catch((error: unknown) => {
    logError('fetch-url tool error', toError(error));
    return handleToolError(error, input.url, 'Failed to fetch URL');
  });
}

/* -------------------------------------------------------------------------------------------------
 * MCP tool definition + registration
 * ------------------------------------------------------------------------------------------------- */

type FetchUrlToolHandler = ToolCallback<typeof fetchUrlInputSchema>;

function withJsonSchema202012(
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (typeof schema['$schema'] === 'string') return schema;
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12_URI,
    ...schema,
  };
}

const TOOL_DEFINITION = {
  name: FETCH_URL_TOOL_NAME,
  title: 'Fetch URL',
  description: FETCH_URL_TOOL_DESCRIPTION,
  inputSchema: fetchUrlInputSchema,
  // Explicitly mark JSON Schema dialect for MCP clients and static reviews.
  outputSchema: withJsonSchema202012(
    z.toJSONSchema(fetchUrlOutputSchema) as Record<string, unknown>
  ),
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
  outputSchema: Record<string, unknown>;
  execution: { taskSupport: 'optional' | 'required' | 'forbidden' };
  annotations: ToolAnnotations;
  handler: FetchUrlToolHandler;
};

function applyRegisteredToolExecutionMetadata(
  registeredTool: {
    execution?:
      | { taskSupport?: 'optional' | 'required' | 'forbidden' | undefined }
      | undefined;
  },
  execution: { taskSupport: 'optional' | 'required' | 'forbidden' }
): void {
  // SDK workaround: RegisteredTool does not expose `execution` in its public type.
  // Keep the mutation localized to one helper so future SDK upgrades touch one place.
  registeredTool.execution = execution;
}

/**
 * Stdio-path guard: ensures a request context (requestId, sessionId) is set
 * in AsyncLocalStorage before invoking the handler. On the HTTP path the SDK
 * populates `extra.requestId`/`extra.requestInfo`, so this is a no-op there.
 * On the stdio path there is no SDK-provided context, so we derive one from
 * the extra fields or generate a fresh UUID.
 */
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
  if (!config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    unregisterTaskCapableTool(FETCH_URL_TOOL_NAME);
    return;
  }

  registerTaskCapableTool({
    name: FETCH_URL_TOOL_NAME,
    parseArguments: (args) => {
      const parsed = fetchUrlInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid arguments for fetch-url'
        );
      }
      return parsed.data;
    },
    execute: fetchUrlToolHandler,
  });

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
  // SDK typing gap workaround: preserve runtime `execution` metadata until the
  // registered tool type includes this field.
  applyRegisteredToolExecutionMetadata(
    registeredTool,
    TOOL_DEFINITION.execution
  );
}
