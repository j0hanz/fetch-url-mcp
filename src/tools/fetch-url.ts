import { randomUUID } from 'node:crypto';

import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { config } from '../lib/core.js';
import {
  getRequestId,
  logDebug,
  logError,
  logWarn,
  runWithRequestContext,
} from '../lib/core.js';
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
  serializeMarkdownResult,
  type SharedFetchStage,
  TRUNCATION_MARKER,
  withSignal,
} from '../lib/mcp-tools.js';
import {
  createProgressReporter,
  type ProgressReporter,
  type ToolHandlerExtra,
} from '../lib/mcp-tools.js';
import { isAbortError, isObject, toError } from '../lib/utils.js';
import { formatZodError } from '../lib/zod.js';

import {
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
} from '../schemas.js';
import {
  registerTaskCapableTool,
  unregisterTaskCapableTool,
} from '../tasks/tool-registry.js';

type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

type ToolContentBlockUnion = ContentBlock;

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
- If truncated=true, full content is available in the next fetch with forceRefresh.
- For large pages/timeouts, use task mode (task: {}).
- If error queue_full, retry with task mode.
</constraints>
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

function buildStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineContentResult,
  inputUrl: string
): Record<string, unknown> {
  const truncated = inlineResult.truncated ?? pipeline.data.truncated;
  const rawMarkdown = applyTruncationMarker(
    inlineResult.content,
    pipeline.data.truncated
  );
  const maxChars = config.constants.maxInlineContentChars;
  const markdown =
    maxChars > 0 ? truncateStr(rawMarkdown, maxChars) : rawMarkdown;
  const metadata = normalizeExtractedMetadata(pipeline.data.metadata);
  const title = normalizePageTitle(pipeline.data.title);

  return {
    url: pipeline.originalUrl ?? pipeline.url,
    resolvedUrl: pipeline.url,
    ...(pipeline.finalUrl ? { finalUrl: pipeline.finalUrl } : {}),
    inputUrl,
    ...(title ? { title } : {}),
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

function buildFetchUrlContentBlocks(
  structuredContent: Record<string, unknown>
): ToolContentBlockUnion[] {
  return [buildTextBlock(structuredContent)];
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
  const content = buildFetchUrlContentBlocks(structuredContent);

  const validation = fetchUrlOutputSchema.safeParse(structuredContent);
  if (!validation.success) {
    logWarn('Tool output schema validation failed', {
      url: inputUrl,
      issues: formatZodError(validation.error),
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

function isCodeHost(host: string): boolean {
  return (
    host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org'
  );
}

function summarizeCodeHostPath(host: string, parts: string[]): string | null {
  if (!isCodeHost(host) || parts.length < 2) return null;

  const p0 = parts[0] ?? '';
  const p1 = parts[1] ?? '';
  return `${host}/${p0}/${p1}`;
}

function summarizeWikipediaPath(parts: string[]): string | null {
  if (parts[0] !== 'wiki' || parts.length < 2) return null;

  const p1 = parts[1] ?? '';
  return `wikipedia.org/${p1}`;
}

function truncatePathSegment(segment: string, max = 20): string {
  if (segment.length <= max) return segment;
  return `${segment.substring(0, max - 3)}...`;
}

function summarizeUrlPath(host: string, parts: string[]): string {
  const codeHostSummary = summarizeCodeHostPath(host, parts);
  if (codeHostSummary) return codeHostSummary;

  if (host.endsWith('wikipedia.org')) {
    const wikipediaSummary = summarizeWikipediaPath(parts);
    if (wikipediaSummary) return wikipediaSummary;
  }

  const basename = truncatePathSegment(parts.at(-1) ?? '');
  if (parts.length === 1) {
    return `${host}/${basename}`;
  }

  return basename ? `${host}/…/${basename}` : host;
}

function getUrlContext(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (path === '/' || path === '') return host;

    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return host;
    return summarizeUrlPath(host, parts);
  } catch {
    return 'unknown';
  }
}

function mapFetchStageToProgress(
  stage: SharedFetchStage,
  context: string
): { step: number; message: string } {
  switch (stage) {
    case 'resolve_url':
      return { step: 2, message: 'Resolving URL' };
    case 'check_cache':
      return { step: 3, message: 'Checking cache' };
    case 'cache_hit':
      return { step: 4, message: 'Loaded from cache' };
    case 'cache_restore':
      return { step: 5, message: 'Restoring cached content' };
    case 'fetch_remote':
      return { step: 4, message: `Fetching ${context}` };
    case 'response_ready':
      return { step: 5, message: 'Received response' };
    case 'transform_start':
      return { step: 6, message: 'Parsing HTML → Markdown' };
    case 'prepare_output':
      return { step: 6, message: 'Preparing output' };
    case 'finalize_output':
      return { step: 7, message: 'Finalizing output' };
  }
}

function buildFetchOptions(
  url: string,
  context: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter | undefined,
  skipNoiseRemoval?: boolean,
  forceRefresh?: boolean,
  maxInlineChars?: number
): Parameters<typeof performSharedFetch>[0] {
  return {
    url,
    ...withSignal(signal),
    ...(skipNoiseRemoval ? { cacheVary: { skipNoiseRemoval: true } } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    ...(maxInlineChars !== undefined ? { maxInlineChars } : {}),
    onStage: (stage) => {
      const update = mapFetchStageToProgress(stage, context);
      reportProgress(progress, update.step, update.message);
    },
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      return markdownTransform(
        { buffer, encoding, ...(truncated ? { truncated } : {}) },
        normalizedUrl,
        signal,
        skipNoiseRemoval
      );
    },
    serialize: serializeMarkdownResult,
    deserialize: parseCachedMarkdownResult,
  };
}

async function fetchPipeline(
  url: string,
  context: string,
  signal?: AbortSignal,
  progress?: ProgressReporter,
  skipNoiseRemoval?: boolean,
  forceRefresh?: boolean,
  maxInlineChars?: number
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineContentResult;
}> {
  return performSharedFetch(
    buildFetchOptions(
      url,
      context,
      signal,
      progress,
      skipNoiseRemoval,
      forceRefresh,
      maxInlineChars
    )
  );
}

function formatContentSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  if (chars < 1_000_000) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function reportProgress(
  progress: ProgressReporter | undefined,
  step: number,
  message: string
): void {
  if (!progress) return;
  progress.report(step, message);
}

async function executeFetch(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  const { url } = input;
  const signal = buildToolAbortSignal(extra?.signal);
  const progress = createProgressReporter(extra);

  const context = getUrlContext(url);
  logDebug('Fetching URL', { url });

  try {
    reportProgress(progress, 1, 'Preparing request');
    const { pipeline, inlineResult } = await fetchPipeline(
      url,
      context,
      signal,
      progress,
      input.skipNoiseRemoval,
      input.forceRefresh,
      input.maxInlineChars
    );

    const size = formatContentSize(inlineResult.contentSize);
    reportProgress(progress, 8, `Done — ${size}`);
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    const isAbort = isAbortError(error);
    reportProgress(progress, 8, isAbort ? 'Cancelled' : 'Failed');
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

const TOOL_DEFINITION = {
  name: FETCH_URL_TOOL_NAME,
  title: 'Fetch URL',
  description: FETCH_URL_TOOL_DESCRIPTION,
  inputSchema: fetchUrlInputSchema,
  outputSchema: z.toJSONSchema(fetchUrlOutputSchema) as Record<string, unknown>,
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
          `Invalid arguments for ${FETCH_URL_TOOL_NAME}: ${formatZodError(parsed.error)}`
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
