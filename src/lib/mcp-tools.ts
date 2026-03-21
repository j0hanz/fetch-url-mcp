import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { FetchError, isAbortError, isSystemError } from './utils.js';

/* -------------------------------------------------------------------------------------------------
 * JSON-RPC / Media type parsing
 * ------------------------------------------------------------------------------------------------- */

export type JsonRpcId = string | number | null;
const paramsSchema = z.looseObject({
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const jsonRpcRequestIdSchema = z.union([z.string(), z.number()]);
const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: jsonRpcRequestIdSchema.optional(),
  params: paramsSchema.optional(),
});
const jsonRpcResultResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema,
  result: z.record(z.string(), z.unknown()),
});
const jsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema.or(z.null()).optional(),
  error: z.strictObject({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});
const jsonRpcResponseSchema = z.union([
  jsonRpcResultResponseSchema,
  jsonRpcErrorResponseSchema,
]);
const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
]);
type McpRequestBody = z.infer<typeof jsonRpcRequestSchema>;
type JsonRpcResponseBody = z.infer<typeof jsonRpcResponseSchema>;
type JsonRpcMessageBody = z.infer<typeof jsonRpcMessageSchema>;
export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}
export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return jsonRpcRequestSchema.safeParse(body).success;
}
export function isJsonRpcResponseBody(
  body: unknown
): body is JsonRpcResponseBody {
  return jsonRpcResponseSchema.safeParse(body).success;
}
export function isMcpMessageBody(body: unknown): body is JsonRpcMessageBody {
  return jsonRpcMessageSchema.safeParse(body).success;
}
function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((v) => v.split(';', 1)[0]?.trim().toLowerCase() ?? '')
    .filter((v) => v.length > 0);
}
export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}
export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = mediaTypes.some(
    (m) => m === '*/*' || m === 'application/json' || m === 'application/*'
  );
  if (!acceptsJson) return false;

  return mediaTypes.some(
    (m) => m === '*/*' || m === 'text/event-stream' || m === 'text/*'
  );
}

/* -------------------------------------------------------------------------------------------------
 * Tool error handling
 * ------------------------------------------------------------------------------------------------- */

type ToolErrorResponse = CallToolResult & {
  isError: true;
};

const PUBLIC_ERROR_REASONS = new Set(['aborted', 'queue_full', 'timeout']);

function sanitizeToolErrorDetails(
  details: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};

  const { retryAfter, timeout, reason } = details;
  if (
    typeof retryAfter === 'number' ||
    typeof retryAfter === 'string' ||
    retryAfter === null
  ) {
    sanitized['retryAfter'] = retryAfter;
  }

  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) {
    sanitized['timeout'] = timeout;
  }

  if (typeof reason === 'string' && PUBLIC_ERROR_REASONS.has(reason)) {
    sanitized['reason'] = reason;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

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
export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  if (error instanceof FetchError) {
    const { code: detailsCode, reason } = error.details;
    const code =
      (typeof detailsCode === 'string'
        ? detailsCode
        : reason === 'queue_full'
          ? 'queue_full'
          : undefined) ?? error.code;
    const details = sanitizeToolErrorDetails(error.details);
    return createToolErrorResponse(error.message, url, {
      code,
      statusCode: error.statusCode,
      ...(details ? { details } : {}),
    });
  }
  if (isValidationError(error)) {
    return createToolErrorResponse(error.message, url, {
      code: 'VALIDATION_ERROR',
    });
  }
  const code = isAbortError(error) ? 'ABORTED' : 'FETCH_ERROR';
  const message =
    error instanceof Error
      ? `${fallbackMessage}: ${error.message}`
      : `${fallbackMessage}: Unknown error`;
  return createToolErrorResponse(message, url, { code });
}
