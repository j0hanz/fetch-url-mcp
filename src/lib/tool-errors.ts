import {
  type CallToolResult,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logError, logWarn } from './core.js';
import {
  ABORTED,
  FETCH_ERROR,
  QUEUE_FULL,
  VALIDATION_ERROR,
} from './error-codes.js';
import { FetchError, isAbortError, isObject, isSystemError } from './utils.js';

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

interface ToolErrorPresentation {
  message: string;
  url: string;
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

const PUBLIC_ERROR_REASONS = new Set(['aborted', QUEUE_FULL, 'timeout']);

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
    category?: string;
    code?: string | number;
    statusCode?: number;
    upstreamMessage?: string;
    details?: Record<string, unknown>;
    data?: unknown;
  }
): ToolErrorResponse {
  const errorContent = createToolErrorPayload(message, url, extra);

  return {
    content: [{ type: 'text', text: JSON.stringify(errorContent) }],
    structuredContent: errorContent,
    isError: true,
  };
}

export function createToolErrorPayload(
  message: string,
  url: string,
  extra?: {
    category?: string;
    code?: string | number;
    statusCode?: number;
    upstreamMessage?: string;
    details?: Record<string, unknown>;
    data?: unknown;
  }
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

function renderToolErrorResponse(
  presentation: ToolErrorPresentation
): ToolErrorResponse {
  return createToolErrorResponse(presentation.message, presentation.url, {
    ...(presentation.category !== undefined
      ? { category: presentation.category }
      : {}),
    ...(presentation.code !== undefined ? { code: presentation.code } : {}),
    ...(presentation.statusCode !== undefined
      ? { statusCode: presentation.statusCode }
      : {}),
    ...(presentation.upstreamMessage !== undefined
      ? { upstreamMessage: presentation.upstreamMessage }
      : {}),
    ...(presentation.details ? { details: presentation.details } : {}),
    ...(presentation.data !== undefined ? { data: presentation.data } : {}),
  });
}

function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === VALIDATION_ERROR
  );
}

function extractHttpStatusText(message: string, statusCode: number): string {
  const prefix = `HTTP ${statusCode}:`;
  if (!message.startsWith(prefix)) return '';
  return message.slice(prefix.length).trim();
}

function buildUpstreamHttpMessage(error: FetchError): string {
  const { statusCode } = error;
  const statusText = extractHttpStatusText(error.message, statusCode);
  const suffix = statusText ? ` ${statusText}` : '';

  if (statusCode === 404) {
    return `The target page returned 404${suffix}.`;
  }

  return `The target server returned ${statusCode}${suffix}.`;
}

function mapFetchToolError(
  error: FetchError,
  fallbackUrl: string
): ToolErrorPresentation {
  const { code: detailsCode, reason } = error.details;
  let { code } = error;
  if (typeof detailsCode === 'string') {
    code = detailsCode;
  } else if (reason === QUEUE_FULL) {
    code = QUEUE_FULL;
  }

  const url = error.url || fallbackUrl;
  const details = sanitizeToolErrorDetails(error.details);

  if (reason === 'timeout') {
    return {
      message: 'The request to the target timed out.',
      url,
      category: 'upstream_timeout',
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...(details ? { details } : {}),
    };
  }

  if (reason === 'aborted') {
    return {
      message: 'The request to the target was cancelled.',
      url,
      category: 'upstream_aborted',
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...(details ? { details } : {}),
    };
  }

  if (reason === QUEUE_FULL) {
    return {
      message: error.message,
      url,
      category: 'queue_full',
      code,
      statusCode: error.statusCode,
      ...(details ? { details } : {}),
    };
  }

  if (typeof error.statusCode === 'number' && error.statusCode >= 400) {
    return {
      message: buildUpstreamHttpMessage(error),
      url,
      category:
        error.statusCode === 429
          ? 'upstream_rate_limited'
          : 'upstream_http_error',
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...(details ? { details } : {}),
    };
  }

  return {
    message: error.message,
    url,
    category: 'fetch_error',
    code,
    statusCode: error.statusCode,
    ...(details ? { details } : {}),
  };
}

function mapGenericToolError(
  error: unknown,
  url: string,
  fallbackMessage: string
): ToolErrorPresentation {
  if (isValidationError(error)) {
    return {
      message: error.message,
      url,
      category: 'validation_error',
      code: VALIDATION_ERROR,
    };
  }

  const isAborted = isAbortError(error);
  return {
    message:
      error instanceof Error
        ? error.message
        : `${fallbackMessage}: unknown error`,
    url,
    category: isAborted ? 'upstream_aborted' : 'fetch_error',
    code: isAborted ? ABORTED : FETCH_ERROR,
  };
}

function resolveToolErrorPresentation(
  error: unknown,
  url: string,
  fallbackMessage: string
): ToolErrorPresentation {
  if (error instanceof FetchError) {
    return mapFetchToolError(error, url);
  }

  return mapGenericToolError(error, url, fallbackMessage);
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  return renderToolErrorResponse(
    resolveToolErrorPresentation(error, url, fallbackMessage)
  );
}

export function classifyAndLogToolError(
  error: unknown,
  meta: ToolErrorLogMeta,
  loggerName: string,
  toolName: string,
  fallbackMessage: string
): ToolErrorResponse {
  if (error instanceof McpError) {
    logError(
      `${toolName} tool failed`,
      { url: meta.url, durationMs: meta.durationMs, error },
      loggerName
    );
    throw error;
  }
  if (error instanceof FetchError || isAbortError(error)) {
    logWarn(
      `${toolName} request failed`,
      {
        url: meta.url,
        error: error instanceof Error ? error.message : String(error),
        durationMs: meta.durationMs,
      },
      loggerName
    );
  } else {
    logError(
      `${toolName} request failed unexpectedly`,
      {
        url: meta.url,
        error: error instanceof Error ? error.message : String(error),
        durationMs: meta.durationMs,
      },
      loggerName
    );
  }
  return handleToolError(error, meta.url, fallbackMessage);
}
