import {
  AppError,
  UrlValidationError,
  FetchError,
  TimeoutError,
} from '../errors/index.js';

/** MCP SDK-compatible error response (index signature required by SDK) */
export type ToolErrorResponse = {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: {
    [x: string]: unknown;
    error: string;
    url: string;
    errorCode: string;
  };
  isError: true;
};

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
    return createToolErrorResponse(error.message, url, 'INVALID_URL');
  }
  if (error instanceof TimeoutError) {
    return createToolErrorResponse(
      `Request timed out after ${error.timeoutMs}ms`,
      url,
      'TIMEOUT'
    );
  }
  if (error instanceof FetchError) {
    const code = error.httpStatus ? `HTTP_${error.httpStatus}` : 'FETCH_ERROR';
    return createToolErrorResponse(error.message, url, code);
  }
  if (error instanceof AppError) {
    return createToolErrorResponse(error.message, url, error.code);
  }

  const message = error instanceof Error ? error.message : 'Unknown error';
  return createToolErrorResponse(`${fallbackMessage}: ${message}`, url, 'UNKNOWN_ERROR');
}
