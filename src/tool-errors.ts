import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { FetchError, isSystemError } from './errors.js';

/* -------------------------------------------------------------------------------------------------
 * Tool error mapping
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

function resolveToolErrorMessage(
  error: unknown,
  fallbackMessage: string
): string {
  if (isValidationError(error) || error instanceof FetchError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${fallbackMessage}: ${error.message}`;
  }
  return `${fallbackMessage}: Unknown error`;
}

function resolveToolErrorCode(error: unknown): string {
  if (isValidationError(error)) return 'VALIDATION_ERROR';
  if (error instanceof FetchError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
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
