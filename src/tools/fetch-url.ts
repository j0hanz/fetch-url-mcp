import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import { config, logError, logInfo, logWarn } from '../lib/core.js';
import {
  finalizeInlineMarkdown,
  type InlineContentResult,
  type MarkdownPipelineResult,
  markdownTransform,
  performSharedFetch,
  type PipelineResult,
  withSignal,
} from '../lib/fetch-pipeline.js';
import type { SharedFetchStage } from '../lib/fetch-pipeline.js';
import {
  createMcpError,
  createProgressReporter,
  handleToolError,
  type ProgressReporter,
  registerToolPresentation,
  type ToolHandlerExtra,
} from '../lib/mcp-interop.js';
import {
  composeAbortSignal,
  FetchError,
  isAbortError,
  isObject,
  parseUrlOrNull,
  toError,
} from '../lib/utils.js';
import { formatZodError } from '../lib/zod.js';

import {
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
  normalizeExtractedMetadata,
  normalizePageTitle,
} from '../schemas.js';
import { withRequestContextIfMissing } from '../tasks/owner.js';
import {
  registerTaskCapableTool,
  setTaskCapableToolSupport,
  type TaskCapableToolDescriptor,
  type TaskCapableToolSupport,
  unregisterTaskCapableTool,
} from '../tasks/registry.js';

type FetchUrlInput = z.infer<typeof fetchUrlInputSchema>;

interface ToolResponseBase {
  [key: string]: unknown;
  content: ContentBlock[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean;
}

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
  const parsed = parseUrlOrNull(urlStr);
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
  structuredContent: Record<string, unknown>,
  inputUrl: string
): void {
  const validation = fetchUrlOutputSchema.safeParse(structuredContent);
  if (validation.success) return;

  const issues = formatZodError(validation.error);
  logWarn(
    'Tool output schema validation failed',
    {
      url: inputUrl,
      issues,
    },
    'fetch-url'
  );
  throw createMcpError(
    ErrorCode.InternalError,
    'fetch-url produced output that does not match its declared outputSchema',
    { issues }
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
): ToolResponseBase {
  const structuredContent = buildStructuredContent(
    pipeline,
    inlineResult,
    inputUrl
  );
  validateStructuredContent(structuredContent, inputUrl);
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
  if (contentSize < 1000) return `${contentSize} chars`;
  if (contentSize < 1_000_000) return `${(contentSize / 1024).toFixed(1)} KB`;
  return `${(contentSize / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFetchSuccessSummary(contentSize: number): string {
  return `Done — ${formatContentSize(contentSize)}`;
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
    this.reporter.report(Step.START, 'Preparing request', this.total);
  }

  reportStage(stage: SharedFetchStage): void {
    const mapped = this.mapStage(stage);
    if (!mapped) return;
    this.reporter.report(mapped.step, mapped.message, this.total);
  }

  reportSuccess(contentSize: number): void {
    this.reporter.report(
      Step.DONE,
      buildFetchSuccessSummary(contentSize),
      this.total
    );
  }

  reportFailure(cancelled: boolean): void {
    this.reporter.report(
      Step.DONE,
      cancelled ? 'Cancelled' : 'Failed',
      this.total
    );
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
          message: 'Received response',
        };
      case 'transform_start':
        return {
          step: Step.TRANSFORM,
          message: 'Parsing HTML -> Markdown',
        };
      case 'prepare_output':
        return {
          step: Step.PREPARE,
          message: 'Fetch completed',
        };
      case 'finalize_output':
        return undefined;
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
    throw createMcpError(
      ErrorCode.InternalError,
      'Tool timeout signal could not be created'
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

async function executeFetch(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  const { url } = input;
  const signal = buildToolAbortSignal(extra?.signal);
  const startedAt = performance.now();
  const relatedTaskMeta =
    extra?._meta?.['io.modelcontextprotocol/related-task'];
  const relatedTask = isObject(relatedTaskMeta) ? relatedTaskMeta : undefined;
  const progressPlan = new FetchUrlProgressPlan(
    createProgressReporter(extra),
    formatUrlForDisplay(url)
  );

  try {
    logInfo(
      'fetch-url started',
      {
        inputUrl: url,
        hasProgressToken: extra?._meta?.progressToken !== undefined,
        ...(isObject(relatedTask) && typeof relatedTask['taskId'] === 'string'
          ? { taskId: relatedTask['taskId'] }
          : {}),
      },
      'fetch-url'
    );
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
      'fetch-url'
    );
    const response = buildResponse(pipeline, inlineResult, url);
    progressPlan.reportSuccess(inlineResult.contentSize);
    return response;
  } catch (error) {
    progressPlan.reportFailure(isAbortError(error));
    throw error;
  }
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput,
  extra?: ToolHandlerExtra
): Promise<ToolResponseBase> {
  const startedAt = performance.now();

  return executeFetch(input, extra).catch((error: unknown) => {
    const durationMs = Math.round(performance.now() - startedAt);
    if (error instanceof McpError) {
      logError(
        'fetch-url tool failed',
        { url: input.url, durationMs, error: toError(error) },
        'fetch-url'
      );
    } else if (error instanceof FetchError || isAbortError(error)) {
      logWarn(
        'fetch-url request failed',
        {
          url: input.url,
          error: toError(error).message,
          durationMs,
        },
        'fetch-url'
      );
    } else {
      logError(
        'fetch-url request failed unexpectedly',
        { url: input.url, error: toError(error).message, durationMs },
        'fetch-url'
      );
    }
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
  outputSchema: fetchUrlOutputSchema,
  handler: fetchUrlToolHandler,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
};

export interface ToolRegistrationControls {
  setTaskSupport: (support: TaskCapableToolSupport) => void;
}

function createTaskCapableDescriptor(): TaskCapableToolDescriptor<FetchUrlInput> {
  return {
    name: TOOL_DEFINITION.name,
    parseArguments: (args: unknown) => {
      const parsed = TOOL_DEFINITION.inputSchema.safeParse(args);
      if (!parsed.success) {
        throw createMcpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${TOOL_DEFINITION.name}: ${formatZodError(parsed.error)}`
        );
      }
      return parsed.data;
    },
    execute: TOOL_DEFINITION.handler,
    getCompletionStatusMessage: getFetchCompletionStatusMessage,
    taskSupport: 'optional',
  };
}

export function registerTools(server: McpServer): ToolRegistrationControls {
  if (!config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    unregisterTaskCapableTool(server, FETCH_URL_TOOL_NAME);
    return {
      setTaskSupport: () => {},
    };
  }

  const descriptor = createTaskCapableDescriptor();
  registerTaskCapableTool(server, descriptor);

  const registeredTool = server.registerTool(
    TOOL_DEFINITION.name,
    {
      title: TOOL_DEFINITION.title,
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      outputSchema: TOOL_DEFINITION.outputSchema,
      annotations: TOOL_DEFINITION.annotations,
      execution: { taskSupport: 'optional' as const },
      icons: [TOOL_ICON],
    } as {
      inputSchema: typeof fetchUrlInputSchema;
      outputSchema: typeof fetchUrlOutputSchema;
    } & Record<string, unknown>,
    withRequestContextIfMissing(TOOL_DEFINITION.handler)
  );
  registerToolPresentation(server, TOOL_DEFINITION.name, {
    icons: [TOOL_ICON],
  });

  const updateTaskSupport = (support: TaskCapableToolSupport): void => {
    setTaskCapableToolSupport(server, FETCH_URL_TOOL_NAME, support);
    registeredTool.execution = { taskSupport: support };
  };

  updateTaskSupport('optional');

  return { setTaskSupport: updateTaskSupport };
}
