import type { ToolErrorResponse } from '../config/types/tools.js';

import { FetchError } from '../errors/app-error.js';

import { isSystemError } from './error-utils.js';

export function createToolErrorResponse(
  message: string,
  url: string
): ToolErrorResponse {
  const structuredContent = {
    error: message,
    url,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  const message = resolveToolErrorMessage(error, fallbackMessage);
  return createToolErrorResponse(message, url);
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
