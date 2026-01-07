import type { ToolErrorResponse } from '../config/types/tools.js';

import { FetchError } from '../errors/app-error.js';

import { isSystemError } from './error-utils.js';

function createFallbackErrorResponse(
  fallbackMessage: string,
  url: string,
  error: Error
): ToolErrorResponse {
  return createToolErrorResponse(`${fallbackMessage}: ${error.message}`, url);
}

function createUnknownErrorResponse(
  fallbackMessage: string,
  url: string
): ToolErrorResponse {
  return createToolErrorResponse(`${fallbackMessage}: Unknown error`, url);
}

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
  if (isValidationError(error)) {
    return createToolErrorResponse(error.message, url);
  }

  if (error instanceof FetchError) {
    return createToolErrorResponse(error.message, url);
  }

  if (error instanceof Error) {
    return createFallbackErrorResponse(fallbackMessage, url, error);
  }

  return createUnknownErrorResponse(fallbackMessage, url);
}

function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === 'VALIDATION_ERROR'
  );
}
