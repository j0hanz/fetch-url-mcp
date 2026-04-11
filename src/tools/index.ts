import {
  type CallToolResult,
  type ContentBlock,
  type McpServer,
  ProtocolErrorCode,
  type ServerContext,
  type ServerResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';

import type { z } from 'zod';

import { config } from '../lib/config.js';
import { logError, Loggers, logInfo } from '../lib/core.js';
import {
  classifyAndLogToolError,
  FetchError,
  getErrorMessage,
  handleToolError,
  isAbortError,
} from '../lib/error/index.js';
import {
  createProgressReporter,
  createProtocolError,
  type ProgressReporter,
  validateOrThrow,
} from '../lib/mcp-interop.js';
import {
  finalizeInlineMarkdown,
  type InlineContentResult,
  type MarkdownPipelineResult,
  markdownTransform,
  performSharedFetch,
  type PipelineResult,
  type SharedFetchStage,
  withSignal,
} from '../lib/net/index.js';
import { composeAbortSignal, isObject } from '../lib/utils.js';

import {
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
} from '../schemas.js';
import {
  attachAbortController,
  detachAbortController,
  withRelatedTaskMeta,
} from '../tasks/index.js';

// Area contract: MCP tool registration and fetch-url response shaping.
// Export only tool-facing registration and handler primitives; keep transport/session ownership and generic shared helpers out.

type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

export const FETCH_URL_TOOL_NAME = 'fetch-url';

const FETCH_URL_TOOL_DESCRIPTION = `
Fetch public webpages and convert HTML to clean Markdown.
`.trim();

const TOOL_ICON = {
  src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPg==',
  mimeType: 'image/svg+xml',
};

const HARD_TOOL_TIMEOUT_MS = 300_000;
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

function formatUrlForDisplay(urlStr: string): string {
  const parsed = URL.parse(urlStr);
  if (!parsed) return 'unknown';

  const host = parsed.hostname.replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
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
  const markdown = finalizeInlineMarkdown(inlineResult.content, {
    maxChars: config.constants.maxInlineContentChars,
  });

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
    fetchedAt: pipeline.fetchedAt,
    contentSize: inlineResult.contentSize,
    ...(truncated ? { truncated: true } : {}),
  };
}

function validateStructuredContent(
  structuredContent: Record<string, unknown>
): void {
  validateOrThrow(
    fetchUrlOutputSchema,
    structuredContent,
    ProtocolErrorCode.InternalError,
    'Output validation failed',
    Loggers.LOG_FETCH_URL
  );
}

export function buildFetchUrlContentBlocks(
  structuredContent: Record<string, unknown>
): ContentBlock[] {
  const markdown =
    typeof structuredContent['markdown'] === 'string'
      ? structuredContent['markdown']
      : '';

  return [
    { type: 'text', text: markdown },
    { type: 'text', text: JSON.stringify(structuredContent) },
  ];
}

function buildResponse(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineContentResult,
  inputUrl: string
): CallToolResult {
  const structuredContent = buildStructuredContent(
    pipeline,
    inlineResult,
    inputUrl
  );
  validateStructuredContent(structuredContent);
  return {
    content: buildFetchUrlContentBlocks(structuredContent),
    structuredContent,
  };
}

const Step = {
  START: 1,
  RESOLVE_URL: 2,
  FETCH: 3,
  RESPONSE: 4,
  TRANSFORM: 5,
  PREPARE: 6,
  DONE: 7,
} as const;

function formatContentSize(contentSize: number): string {
  if (contentSize < 1024) return `${contentSize} B`;
  if (contentSize < 1_048_576) {
    const kb = contentSize / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${kb.toFixed(0)} KB`;
  }
  return `${(contentSize / 1_048_576).toFixed(1)} MB`;
}

function buildFetchSuccessSummary(contentSize: number): string {
  return `Fetch completed \u2022 ${formatContentSize(contentSize)}`;
}

export function getFetchCompletionStatusMessage(
  result: ServerResult
): string | undefined {
  if (!isObject(result)) return undefined;

  const { structuredContent } = result as { structuredContent?: unknown };
  if (!isObject(structuredContent)) return undefined;

  const { contentSize } = structuredContent;
  return typeof contentSize === 'number'
    ? buildFetchSuccessSummary(contentSize)
    : undefined;
}

export class FetchUrlProgressPlan {
  private readonly total = Step.DONE;

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly context: string
  ) {}

  reportStart(): void {
    this.reporter.report({
      progress: Step.START,
      message: 'Preparing',
      total: this.total,
    });
  }

  reportStage(stage: SharedFetchStage): void {
    const mapped = this.mapStage(stage);
    if (!mapped) return;
    this.reporter.report({
      progress: mapped.step,
      message: mapped.message,
      total: this.total,
    });
  }

  reportSuccess(contentSize: number): void {
    this.reporter.report({
      progress: Step.DONE,
      message: buildFetchSuccessSummary(contentSize),
      total: this.total,
    });
  }

  reportFailure(cancelled: boolean, error?: unknown): void {
    let message: string;
    if (cancelled) {
      message = 'Cancelled';
    } else if (error instanceof FetchError && error.statusCode > 0) {
      message = `Fetch failed \u2022 ${String(error.statusCode)}`;
    } else {
      message = 'Fetch failed';
    }
    this.reporter.report({
      progress: Step.DONE,
      message,
      total: this.total,
    });
  }

  private mapStage(
    stage: SharedFetchStage
  ): { step: number; message: string } | undefined {
    switch (stage) {
      case 'resolve_url':
        return {
          step: Step.RESOLVE_URL,
          message: 'Resolving URL',
        };
      case 'fetch_remote':
        return {
          step: Step.FETCH,
          message: `Fetching ${this.context}`,
        };
      case 'response_ready':
        return {
          step: Step.RESPONSE,
          message: 'Processing response',
        };
      case 'transform_start':
        return {
          step: Step.TRANSFORM,
          message: 'Converting to Markdown',
        };
      case 'prepare_output':
        return {
          step: Step.PREPARE,
          message: 'Finalizing',
        };
      case 'finalize_output':
        return {
          step: Step.DONE,
          message: 'Fetch completed',
        };
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Fetch pipeline
 * ------------------------------------------------------------------------------------------------- */

function buildToolAbortSignal(extraSignal?: AbortSignal): AbortSignal {
  const timeout =
    config.tools.timeoutMs > 0 ? config.tools.timeoutMs : HARD_TOOL_TIMEOUT_MS;
  const signal = composeAbortSignal(extraSignal, timeout);
  if (!signal) {
    throw createProtocolError(
      ProtocolErrorCode.InternalError,
      'Failed to create timeout signal'
    );
  }
  return signal;
}

function buildFetchOptions(
  url: string,
  signal: AbortSignal | undefined,
  progressPlan: FetchUrlProgressPlan
): Parameters<typeof performSharedFetch>[0] {
  return {
    url,
    ...withSignal(signal),
    onStage: (stage) => {
      progressPlan.reportStage(stage);
    },
    transform: async ({ buffer, encoding, truncated }, normalizedUrl) => {
      return markdownTransform(
        { buffer, encoding, ...(truncated ? { truncated } : {}) },
        normalizedUrl,
        signal
      );
    },
  };
}

async function writeRequestScopedLog(
  ctx: ServerContext | undefined,
  level: 'info' | 'warning' | 'error',
  message: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!ctx) return;

  try {
    await ctx.mcpReq.log(level, { message, ...data }, Loggers.LOG_FETCH_URL);
  } catch {
    // Request-scoped logging is best-effort; internal logging remains authoritative.
  }
}

async function executeFetch(
  input: FetchUrlInput,
  ctx?: ServerContext,
  executionSignal?: AbortSignal
): Promise<CallToolResult> {
  const { url } = input;
  const mcpReq = ctx?.mcpReq;
  const signal = buildToolAbortSignal(executionSignal ?? mcpReq?.signal);
  const startedAt = performance.now();
  const meta = mcpReq?._meta;
  const progressToken = meta?.progressToken;
  const taskId = ctx?.task?.id;
  const progressPlan = new FetchUrlProgressPlan(
    createProgressReporter(ctx),
    formatUrlForDisplay(url)
  );

  try {
    logInfo(
      'fetch-url started',
      {
        inputUrl: url,
        hasProgressToken: progressToken !== undefined,
        ...(taskId ? { taskId } : {}),
      },
      Loggers.LOG_FETCH_URL
    );
    await writeRequestScopedLog(ctx, 'info', 'fetch-url started', {
      inputUrl: url,
      ...(taskId ? { taskId } : {}),
    });
    progressPlan.reportStart();
    const { pipeline, inlineResult } = await performSharedFetch(
      buildFetchOptions(url, signal, progressPlan)
    );
    const truncated = inlineResult.truncated ?? pipeline.data.truncated;

    logInfo(
      'fetch-url completed',
      {
        inputUrl: url,
        resolvedUrl: pipeline.url,
        ...(pipeline.finalUrl ? { finalUrl: pipeline.finalUrl } : {}),
        contentSize: inlineResult.contentSize,
        durationMs: Math.round(performance.now() - startedAt),
        ...(truncated ? { truncated: true } : {}),
      },
      Loggers.LOG_FETCH_URL
    );
    await writeRequestScopedLog(ctx, 'info', 'fetch-url completed', {
      inputUrl: url,
      resolvedUrl: pipeline.url,
      contentSize: inlineResult.contentSize,
      ...(taskId ? { taskId } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
    const response = buildResponse(pipeline, inlineResult, url);
    progressPlan.reportSuccess(inlineResult.contentSize);
    return response;
  } catch (error) {
    progressPlan.reportFailure(isAbortError(error), error);
    await writeRequestScopedLog(
      ctx,
      isAbortError(error) ? 'warning' : 'error',
      'fetch-url failed',
      {
        inputUrl: url,
        error: getErrorMessage(error),
        ...(taskId ? { taskId } : {}),
      }
    );
    throw error;
  }
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput,
  ctx?: ServerContext
): Promise<CallToolResult> {
  const startedAt = performance.now();

  return executeFetch(input, ctx).catch((error: unknown) => {
    const durationMs = Math.round(performance.now() - startedAt);
    return classifyAndLogToolError(
      error,
      { url: input.url, durationMs },
      Loggers.LOG_FETCH_URL,
      'fetch-url',
      'Failed to fetch URL'
    );
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
  outputSchema: fetchUrlOutputSchema,
  handler: fetchUrlToolHandler,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
};

type TaskCapableToolSupport = 'required' | 'optional' | 'forbidden';

export interface ToolRegistrationControls {
  setTaskSupport: (support: TaskCapableToolSupport) => void;
}

export function registerTools(server: McpServer): ToolRegistrationControls {
  if (!config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    return {
      setTaskSupport: () => {},
    };
  }

  const registeredTool = server.experimental.tasks.registerToolTask(
    TOOL_DEFINITION.name,
    {
      title: TOOL_DEFINITION.title,
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      outputSchema: TOOL_DEFINITION.outputSchema,
      annotations: TOOL_DEFINITION.annotations,
      execution: { taskSupport: 'optional' },
      _meta: { icons: [TOOL_ICON] },
    },
    {
      createTask: async (args, ctx) => {
        const task = await ctx.task.store.createTask(
          ctx.task.requestedTtl !== undefined
            ? { ttl: ctx.task.requestedTtl }
            : {}
        );
        const taskSignal = attachAbortController(task.taskId).signal;

        // Spin off background execution
        executeFetch(args, ctx, taskSignal)
          .then(async (result) => {
            try {
              await ctx.task.store.storeTaskResult(
                task.taskId,
                'completed',
                result
              );
            } catch (storeError: unknown) {
              logError(
                'Failed to store completed task result',
                {
                  taskId: task.taskId,
                  error: getErrorMessage(storeError),
                },
                Loggers.LOG_TASKS
              );
              await ctx.task.store.updateTaskStatus(
                task.taskId,
                'failed',
                'Failed to store result'
              );
            }
          })
          .catch(async (error: unknown) => {
            logError(
              'Background execution crashed',
              { taskId: task.taskId, error: getErrorMessage(error) },
              Loggers.LOG_TASKS
            );
            const errorResult = handleToolError(
              error,
              args.url,
              'Background execution failed'
            );
            try {
              await ctx.task.store.storeTaskResult(
                task.taskId,
                'failed',
                errorResult
              );
            } catch (storeError: unknown) {
              logError(
                'Failed to store task error result',
                {
                  taskId: task.taskId,
                  error: getErrorMessage(storeError),
                },
                Loggers.LOG_TASKS
              );
              await ctx.task.store.updateTaskStatus(
                task.taskId,
                'failed',
                getErrorMessage(error)
              );
            }
          })
          .finally(() => {
            detachAbortController(task.taskId);
          });

        return { task };
      },
      getTask: async (_args, ctx) => {
        return ctx.task.store.getTask(ctx.task.id);
      },
      getTaskResult: async (_args, ctx) => {
        const result = (await ctx.task.store.getTaskResult(
          ctx.task.id
        )) as CallToolResult;
        return withRelatedTaskMeta(result, ctx.task.id) as CallToolResult;
      },
    }
  );

  const updateTaskSupport = (support: TaskCapableToolSupport): void => {
    registeredTool.execution = { taskSupport: support };
  };

  return { setTaskSupport: updateTaskSupport };
}
