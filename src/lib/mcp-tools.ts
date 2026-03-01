import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import { FetchError, isAbortError, isSystemError } from './utils.js';

/* -------------------------------------------------------------------------------------------------
 * JSON-RPC / Media type parsing
 * ------------------------------------------------------------------------------------------------- */

export type JsonRpcId = string | number | null;
interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}
interface McpRequestBody {
  jsonrpc: '2.0';
  method: string;
  id?: JsonRpcId;
  params?: McpRequestParams;
}
const paramsSchema = z.looseObject({});
const mcpRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: paramsSchema.optional(),
});
export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}
export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}
function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((value) => extractAcceptMediaType(value.trim()))
    .filter((value) => value.length > 0);
}
function extractAcceptMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}
function hasAcceptedMediaType(
  mediaTypes: readonly string[],
  exact: string,
  wildcardPrefix: string
): boolean {
  return mediaTypes.some(
    (mediaType) =>
      typeof mediaType === 'string' &&
      mediaType.length > 0 &&
      (mediaType === '*/*' ||
        mediaType === exact ||
        mediaType === wildcardPrefix)
  );
}
export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = hasAcceptedMediaType(
    mediaTypes,
    'application/json',
    'application/*'
  );
  if (!acceptsJson) return false;

  return hasAcceptedMediaType(mediaTypes, 'text/event-stream', 'text/*');
}

/* -------------------------------------------------------------------------------------------------
 * Tool error handling
 * ------------------------------------------------------------------------------------------------- */

type ToolErrorResponse = CallToolResult & {
  isError: true;
};
export function createToolErrorResponse(
  message: string,
  url: string,
  extra?: {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  }
): ToolErrorResponse {
  const errorContent: Record<string, unknown> = {
    error: message,
    ...(extra?.code ? { code: extra.code } : {}),
    url,
    ...(extra?.statusCode !== undefined
      ? { statusCode: extra.statusCode }
      : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(errorContent) }],
    isError: true,
  };
}
function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === 'VALIDATION_ERROR'
  );
}
function isHandledToolError(
  error: unknown
): error is FetchError | NodeJS.ErrnoException {
  return error instanceof FetchError || isValidationError(error);
}
function resolveToolErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  if (isHandledToolError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${fallbackMessage}: ${error.message}`;
  }
  return `${fallbackMessage}: Unknown error`;
}
function resolveToolErrorCode(error: unknown): string {
  if (error instanceof FetchError) return error.code;
  if (isValidationError(error)) return 'VALIDATION_ERROR';
  if (isAbortError(error)) return 'ABORTED';
  return 'FETCH_ERROR';
}
export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  const message = resolveToolErrorMessage(error, fallbackMessage);
  const code = resolveToolErrorCode(error);
  if (error instanceof FetchError) {
    return createToolErrorResponse(message, url, {
      code,
      statusCode: error.statusCode,
      details: error.details,
    });
  }
  return createToolErrorResponse(message, url, { code });
}

/* -------------------------------------------------------------------------------------------------
 * Re-exports from split modules
 *
 * Preserves backward compatibility — consumers import from 'lib/mcp-tools.js'
 * without changes. Direct imports from the sub-modules are preferred for new code.
 * ------------------------------------------------------------------------------------------------- */

export {
  registerServerLifecycleCleanup,
  registerTaskHandlers,
  cancelTasksForOwner,
  abortAllTaskExecutions,
} from './task-handlers.js';

export {
  readString,
  readNestedRecord,
  withSignal,
  TRUNCATION_MARKER,
  type InlineContentResult,
  appendTruncationMarker,
  type PipelineResult,
  executeFetchPipeline,
  type MarkdownPipelineResult,
  parseCachedMarkdownResult,
  markdownTransform,
  serializeMarkdownResult,
  performSharedFetch,
} from './fetch-pipeline.js';

export {
  type ProgressNotificationParams,
  type ProgressNotification,
  type ToolHandlerExtra,
  type ProgressReporter,
  createProgressReporter,
} from './progress.js';
