import type { ToolErrorResponse } from '../config/types.js';

import {
  AbortError,
  AppError,
  FetchError,
  RateLimitError,
  TimeoutError,
  UrlValidationError,
} from '../errors/index.js';

const isDevelopment = process.env.NODE_ENV === 'development';

export function createToolErrorResponse(
  message: string,
  url: string,
  code: string
): ToolErrorResponse {
  const structuredContent = { error: message, url, errorCode: code };
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
  if (error instanceof UrlValidationError) {
    const message = isDevelopment
      ? `${error.message}\nURL: ${error.url}\nStack: ${error.stack ?? ''}`
      : error.message;
    return createToolErrorResponse(message, url, 'INVALID_URL');
  }
  if (error instanceof AbortError) {
    const message = isDevelopment
      ? `Request aborted${error.reason ? `: ${error.reason}` : ''}\n${error.stack ?? ''}`
      : `Request aborted${error.reason ? `: ${error.reason}` : ''}`;
    return createToolErrorResponse(message, url, 'ABORTED');
  }
  if (error instanceof TimeoutError) {
    const message = isDevelopment
      ? `Request timed out after ${error.timeoutMs}ms\n${error.stack ?? ''}`
      : `Request timed out after ${error.timeoutMs}ms`;
    return createToolErrorResponse(message, url, 'TIMEOUT');
  }
  if (error instanceof RateLimitError) {
    const message = isDevelopment
      ? `Rate limited. Retry after ${error.retryAfter}s\n${error.stack ?? ''}`
      : `Rate limited. Retry after ${error.retryAfter}s`;
    return createToolErrorResponse(message, url, 'RATE_LIMITED');
  }
  if (error instanceof FetchError) {
    const code = error.httpStatus ? `HTTP_${error.httpStatus}` : 'FETCH_ERROR';
    const message = isDevelopment
      ? `${error.message}\n${error.stack ?? ''}`
      : error.message;
    return createToolErrorResponse(message, url, code);
  }
  if (error instanceof AppError) {
    const message = isDevelopment
      ? `${error.message}\n${error.stack ?? ''}`
      : error.message;
    return createToolErrorResponse(message, url, error.code);
  }

  const message = error instanceof Error ? error.message : 'Unknown error';
  const fullMessage =
    isDevelopment && error instanceof Error
      ? `${fallbackMessage}: ${message}\n${error.stack ?? ''}`
      : `${fallbackMessage}: ${message}`;

  return createToolErrorResponse(fullMessage, url, 'UNKNOWN_ERROR');
}
