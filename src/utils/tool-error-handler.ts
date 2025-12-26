import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { ToolErrorResponse } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

const IS_DEVELOPMENT_WITH_STACK_TRACES =
  process.env.NODE_ENV === 'development' &&
  process.env.EXPOSE_STACK_TRACES === 'true';

const MCP_ERROR_CODE_MAP: Record<string, string> = {
  VALIDATION_ERROR: String(ErrorCode.InvalidParams),
  INVALID_PARAMS: String(ErrorCode.InvalidParams),
  INTERNAL_ERROR: String(ErrorCode.InternalError),
  FETCH_ERROR: String(ErrorCode.InternalError),
  BATCH_ERROR: String(ErrorCode.InternalError),
  PROMISE_REJECTED: String(ErrorCode.InternalError),
  UNKNOWN_ERROR: String(ErrorCode.InternalError),
};

const NUMERIC_ERROR_CODE = /^-?\d+$/;

function normalizeToolErrorCode(code: string): string {
  if (!code) return String(ErrorCode.InternalError);
  if (NUMERIC_ERROR_CODE.test(code)) return code;
  if (code.startsWith('HTTP_')) return String(ErrorCode.InternalError);
  return MCP_ERROR_CODE_MAP[code] ?? code;
}

export function createToolErrorResponse(
  message: string,
  url: string,
  code: string
): ToolErrorResponse {
  const structuredContent = {
    error: message,
    url,
    errorCode: normalizeToolErrorCode(code),
    errorType: code,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function formatErrorMessage(
  baseMessage: string,
  error: Error,
  fallback?: string
): string {
  const message = fallback ? `${fallback}: ${error.message}` : error.message;

  if (IS_DEVELOPMENT_WITH_STACK_TRACES && error.stack) {
    return `${message}\n${error.stack}`;
  }

  return message;
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  if (error instanceof FetchError) {
    const message = formatErrorMessage(error.message, error);
    return createToolErrorResponse(message, url, error.code);
  }

  if (error instanceof Error) {
    const message = formatErrorMessage(error.message, error, fallbackMessage);
    return createToolErrorResponse(message, url, 'UNKNOWN_ERROR');
  }

  return createToolErrorResponse(
    `${fallbackMessage}: Unknown error`,
    url,
    'UNKNOWN_ERROR'
  );
}
