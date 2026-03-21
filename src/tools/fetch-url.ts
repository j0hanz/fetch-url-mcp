import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContentBlock,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { config, logDebug, logError, logWarn } from '../lib/core.js';
import {
  finalizeInlineMarkdown,
  type InlineContentResult,
  type MarkdownPipelineResult,
  markdownTransform,
  parseCachedMarkdownResult,
  performSharedFetch,
  type PipelineResult,
  serializeMarkdownResult,
  withSignal,
} from '../lib/fetch-pipeline.js';
import { handleToolError } from '../lib/mcp-tools.js';
import {
  createProgressReporter,
  type ToolHandlerExtra,
} from '../lib/progress.js';
import { isAbortError, toError } from '../lib/utils.js';
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
  type TaskCapableToolDescriptor,
  unregisterTaskCapableTool,
} from '../tasks/tool-registry.js';
import {
  FetchUrlProgressPlan,
  getFetchCompletionStatusMessage,
} from './fetch-url-progress.js';

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
    truncated: pipeline.data.truncated,
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
    fromCache: pipeline.fromCache,
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

function buildContentBlocks(
  structuredContent: Record<string, unknown>
): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(structuredContent) }];
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
    content: buildContentBlocks(structuredContent),
    structuredContent,
  };
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
  signal: AbortSignal | undefined,
  progressPlan: FetchUrlProgressPlan,
  forceRefresh?: boolean
): Parameters<typeof performSharedFetch>[0] {
  return {
    url,
    ...withSignal(signal),
    ...(forceRefresh ? { forceRefresh: true } : {}),
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
  const progressPlan = new FetchUrlProgressPlan(
    createProgressReporter(extra),
    getUrlContext(url)
  );

  logDebug('Fetching URL', { url });

  try {
    progressPlan.reportStart();
    const { pipeline, inlineResult } = await performSharedFetch(
      buildFetchOptions(url, signal, progressPlan, input.forceRefresh)
    );

    progressPlan.reportSuccess(inlineResult.contentSize);
    return buildResponse(pipeline, inlineResult, url);
  } catch (error) {
    progressPlan.reportFailure(isAbortError(error));
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
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } satisfies ToolAnnotations,
};

type TaskSupport = 'optional' | 'forbidden';

export interface ToolRegistrationControls {
  setTaskSupport: (support: TaskSupport) => void;
}

function createTaskCapableDescriptor(): TaskCapableToolDescriptor<FetchUrlInput> {
  return {
    name: FETCH_URL_TOOL_NAME,
    parseArguments: (args: unknown) => {
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
    getCompletionStatusMessage: getFetchCompletionStatusMessage,
  };
}

function setRegisteredToolTaskSupport(
  registeredTool: Record<string, unknown>,
  support: TaskSupport
): void {
  registeredTool.execution = { taskSupport: support };
}

export function registerTools(server: McpServer): ToolRegistrationControls {
  if (!config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    unregisterTaskCapableTool(FETCH_URL_TOOL_NAME);
    return {
      setTaskSupport: () => {},
    };
  }

  const descriptor = createTaskCapableDescriptor();
  registerTaskCapableTool(descriptor);

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
    } as { inputSchema: typeof fetchUrlInputSchema } & Record<string, unknown>,
    withRequestContextIfMissing(TOOL_DEFINITION.handler)
  );

  const registeredToolRecord = registeredTool as Record<string, unknown>;
  setRegisteredToolTaskSupport(registeredToolRecord, 'optional');

  return {
    setTaskSupport: (support) => {
      if (support === 'optional') {
        registerTaskCapableTool(descriptor);
      } else {
        unregisterTaskCapableTool(FETCH_URL_TOOL_NAME);
      }
      setRegisteredToolTaskSupport(registeredToolRecord, support);
    },
  };
}
