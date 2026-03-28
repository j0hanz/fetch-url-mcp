import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { isObject } from '../utils.js';
import { SystemErrors } from './codes.js';

export type ToolErrorResponse = CallToolResult & {
  isError: true;
};

export interface ToolErrorLogMeta {
  url: string;
  durationMs: number;
}

export interface ToolErrorPayload extends Record<string, unknown> {
  error: string;
  url: string;
  category?: string;
  code?: string | number;
  statusCode?: number;
  upstreamMessage?: string;
  details?: Record<string, unknown>;
  data?: unknown;
}

export interface ToolErrorExtra {
  category?: string;
  code?: string | number;
  statusCode?: number;
  upstreamMessage?: string;
  details?: Record<string, unknown>;
  data?: unknown;
}

const toolErrorPayloadSchema = z.strictObject({
  error: z.string(),
  url: z.string(),
  category: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  statusCode: z.number().int().optional(),
  upstreamMessage: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  data: z.unknown().optional(),
});

const PUBLIC_ERROR_REASONS = new Set([
  'aborted',
  SystemErrors.QUEUE_FULL,
  'timeout',
]);

export function sanitizeToolErrorDetails(
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
  extra?: ToolErrorExtra
): ToolErrorResponse {
  const errorContent = createToolErrorPayload(message, url, extra);

  return {
    content: [{ type: 'text', text: JSON.stringify(errorContent) }],
    isError: true,
  };
}

export function createToolErrorPayload(
  message: string,
  url: string,
  extra?: ToolErrorExtra
): ToolErrorPayload {
  const payload: ToolErrorPayload = {
    error: message,
    url,
  };

  if (extra?.category !== undefined) payload.category = extra.category;
  if (extra?.code !== undefined) payload.code = extra.code;
  if (extra?.statusCode !== undefined) payload.statusCode = extra.statusCode;
  if (extra?.upstreamMessage !== undefined) {
    payload.upstreamMessage = extra.upstreamMessage;
  }
  if (extra?.details) payload.details = extra.details;
  if (extra?.data !== undefined) payload.data = extra.data;

  return payload;
}

function normalizeToolErrorPayload(
  value: z.infer<typeof toolErrorPayloadSchema>
): ToolErrorPayload {
  return createToolErrorPayload(value.error, value.url, {
    ...(value.category !== undefined ? { category: value.category } : {}),
    ...(value.code !== undefined ? { code: value.code } : {}),
    ...(value.statusCode !== undefined ? { statusCode: value.statusCode } : {}),
    ...(value.upstreamMessage !== undefined
      ? { upstreamMessage: value.upstreamMessage }
      : {}),
    ...(value.details ? { details: value.details } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  });
}

export function tryReadToolErrorPayload(
  value: unknown
): ToolErrorPayload | undefined {
  if (!isObject(value)) return undefined;

  const structuredContent = toolErrorPayloadSchema.safeParse(
    value['structuredContent']
  );
  if (structuredContent.success) {
    return normalizeToolErrorPayload(structuredContent.data);
  }

  const { content } = value;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const firstBlock: unknown = content[0];
  if (!isObject(firstBlock)) return undefined;
  if (firstBlock['type'] !== 'text') return undefined;
  if (typeof firstBlock['text'] !== 'string') return undefined;

  try {
    const payload = toolErrorPayloadSchema.safeParse(
      JSON.parse(firstBlock['text'])
    );
    return payload.success
      ? normalizeToolErrorPayload(payload.data)
      : undefined;
  } catch {
    return undefined;
  }
}

export function tryReadToolErrorMessage(value: unknown): string | undefined {
  return tryReadToolErrorPayload(value)?.error;
}

const mcpErrorPrefixPattern = /^MCP error -?\d+:\s*/;

export function stripMcpErrorPrefix(message: string): string {
  return message.replace(mcpErrorPrefixPattern, '');
}
