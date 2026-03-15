import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  config,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  runWithRequestContext,
} from '../lib/core.js';
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
} from '../lib/fetch-pipeline.js';
import { handleToolError } from '../lib/mcp-tools.js';
import {
  createProgressReporter,
  type ProgressReporter,
  type ToolHandlerExtra,
} from '../lib/progress.js';
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

interface ToolResponseBase {
  [key: string]: unknown;
  content: ContentBlock[];
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

const HARD_TOOL_TIMEOUT_MS = 300_000;
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/* -------------------------------------------------------------------------------------------------
 * URL context & progress
 * ------------------------------------------------------------------------------------------------- */

function getUrlContext(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return host;

    if (CODE_HOSTS.has(host) && parts.length >= 2) {
      return `${host}/${parts[0] ?? ''}/${parts[1] ?? ''}`;
    }
    if (
      host.endsWith('wikipedia.org') &&
      parts[0] === 'wiki' &&
      parts.length >= 2
    ) {
      return `wikipedia.org/${parts[1] ?? ''}`;
    }

    const raw = parts.at(-1) ?? '';
    const basename = raw.length > 20 ? `${raw.substring(0, 17)}...` : raw;
    if (parts.length === 1) return `${host}/${basename}`;
    return basename ? `${host}/…/${basename}` : host;
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

/* -------------------------------------------------------------------------------------------------
 * Response assembly
 * ------------------------------------------------------------------------------------------------- */

function buildStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineContentResult,
  inputUrl: string
): Record<string, unknown> {
  const truncated = inlineResult.truncated ?? pipeline.data.truncated;

  let markdown = inlineResult.content;
  if (pipeline.data.truncated && typeof markdown === 'string') {
    markdown = appendTruncationMarker(markdown, TRUNCATION_MARKER);
  }
  const maxChars = config.constants.maxInlineContentChars;
  if (maxChars > 0 && markdown !== undefined && markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
  }

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
  const content: ContentBlock[] = [
    { type: 'text', text: JSON.stringify(structuredContent) },
  ];

  const validation = fetchUrlOutputSchema.safeParse(structuredContent);
  if (!validation.success) {
    const issues = formatZodError(validation.error);
    logWarn('Tool output schema validation failed', {
      url: inputUrl,
      issues,
    });
    throw new McpError(
      ErrorCode.InternalError,
      'fetch-url produced output that does not match its declared outputSchema',
      { issues }
    );
  }

  return { content, structuredContent };
}

/* -------------------------------------------------------------------------------------------------
 * Fetch pipeline
 * ------------------------------------------------------------------------------------------------- */

function buildToolAbortSignal(extraSignal?: AbortSignal): AbortSignal {
  const timeout =
    config.tools.timeoutMs > 0 ? config.tools.timeoutMs : HARD_TOOL_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeout);
  return extraSignal
    ? AbortSignal.any([extraSignal, timeoutSignal])
    : timeoutSignal;
}

function buildFetchOptions(
  url: string,
  context: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter | undefined,
  forceRefresh?: boolean
): Parameters<typeof performSharedFetch>[0] {
  return {
    url,
    ...withSignal(signal),
    ...(forceRefresh ? { forceRefresh: true } : {}),
    onStage: (stage) => {
      const { step, message } = mapFetchStageToProgress(stage, context);
      progress?.report(step, message);
    },
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      return markdownTransform(
        { buffer, encoding, ...(truncated ? { truncated } : {}) },
        normalizedUrl,
        signal
      );
    },
    serialize: serializeMarkdownResult,
    deserialize: parseCachedMarkdownResult,
  };
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
    progress.report(1, 'Preparing request');
    const { pipeline, inlineResult } = await performSharedFetch(
      buildFetchOptions(url, context, signal, progress, input.forceRefresh)
    );

    const chars = inlineResult.contentSize;
    const size =
      chars < 1000
        ? `${chars} chars`
        : chars < 1_000_000
          ? `${(chars / 1024).toFixed(1)} KB`
          : `${(chars / (1024 * 1024)).toFixed(1)} MB`;
    progress.report(8, `Done — ${size}`);
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    progress.report(8, isAbortError(error) ? 'Cancelled' : 'Failed');
    throw error;
  }
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  return executeFetch(input, extra).catch((error: unknown) => {
    logError('fetch-url tool error', toError(error));
    if (error instanceof McpError) {
      throw error;
    }
    return handleToolError(error, input.url, 'Failed to fetch URL');
  });
}

/* -------------------------------------------------------------------------------------------------
 * MCP tool definition + registration
 * ------------------------------------------------------------------------------------------------- */

const TOOL_DEFINITION = {
  name: FETCH_URL_TOOL_NAME,
  title: 'Fetch URL',
  description: FETCH_URL_TOOL_DESCRIPTION,
  inputSchema: fetchUrlInputSchema,
  outputSchema: z.toJSONSchema(fetchUrlOutputSchema) as Record<string, unknown>,
  handler: fetchUrlToolHandler,
  execution: { taskSupport: 'optional' } as const,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
};

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
  // SDK workaround: RegisteredTool type omits `execution`
  (registeredTool as Record<string, unknown>).execution =
    TOOL_DEFINITION.execution;
}
