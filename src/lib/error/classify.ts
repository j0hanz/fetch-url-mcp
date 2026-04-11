import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/server';

import { logError, logWarn } from '../core.js';
import { FetchError, isAbortError, isSystemError } from './classes.js';
import { ErrorCategory, SystemErrors } from './codes.js';
import {
  createToolErrorResponse,
  sanitizeToolErrorDetails,
  stripProtocolErrorPrefix,
  type ToolErrorLogMeta,
  type ToolErrorPayload,
  type ToolErrorResponse,
} from './payload.js';

function toToolErrorResponse(payload: ToolErrorPayload): ToolErrorResponse {
  return createToolErrorResponse(payload.error, payload.url, payload);
}

function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === SystemErrors.VALIDATION_ERROR
  );
}

function buildUpstreamHttpMessage(error: FetchError): string {
  const { statusCode } = error;

  if (statusCode === 404) {
    return `We couldn't find the resource at the target URL.`;
  }

  return `An error occurred when communicating with the target URL.`;
}

function resolveFetchErrorCode(error: FetchError): string {
  const { code: detailsCode, reason } = error.details;
  if (typeof detailsCode === 'string') return detailsCode;
  if (reason === SystemErrors.QUEUE_FULL) return SystemErrors.QUEUE_FULL;
  return error.code;
}

function mapFetchToolError(
  error: FetchError,
  fallbackUrl: string
): ToolErrorPayload {
  const { reason } = error.details;
  const code = resolveFetchErrorCode(error);
  const url = error.url || fallbackUrl;
  const details = sanitizeToolErrorDetails(error.details);
  const detailsSpread = details ? { details } : {};

  if (reason === 'timeout') {
    return {
      error: 'The request to the target timed out.',
      url,
      category: ErrorCategory.UPSTREAM_TIMEOUT,
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...detailsSpread,
    };
  }

  if (reason === 'aborted') {
    return {
      error: 'The request to the target was cancelled.',
      url,
      category: ErrorCategory.UPSTREAM_ABORTED,
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...detailsSpread,
    };
  }

  if (reason === SystemErrors.QUEUE_FULL) {
    return {
      error: error.message,
      url,
      category: ErrorCategory.QUEUE_FULL,
      code,
      statusCode: error.statusCode,
      ...detailsSpread,
    };
  }

  const isRealHttpError = typeof error.details['httpStatus'] === 'number';

  if (isRealHttpError && error.statusCode >= 400) {
    const category =
      error.statusCode === 429
        ? ErrorCategory.UPSTREAM_RATE_LIMITED
        : ErrorCategory.UPSTREAM_HTTP_ERROR;
    return {
      error: buildUpstreamHttpMessage(error),
      url,
      category,
      code,
      statusCode: error.statusCode,
      upstreamMessage: error.message,
      ...detailsSpread,
    };
  }

  return {
    error: error.message,
    url,
    category: ErrorCategory.FETCH_ERROR,
    code,
    statusCode: error.statusCode,
    ...detailsSpread,
  };
}

function mapGenericToolError(
  error: unknown,
  url: string,
  fallbackMessage: string
): ToolErrorPayload {
  if (isValidationError(error)) {
    return {
      error: error.message,
      url,
      category: ErrorCategory.VALIDATION_ERROR,
      code: SystemErrors.VALIDATION_ERROR,
    };
  }

  const isAborted = isAbortError(error);
  return {
    error:
      error instanceof Error
        ? error.message
        : `${fallbackMessage}: unknown error`,
    url,
    category: isAborted
      ? ErrorCategory.UPSTREAM_ABORTED
      : ErrorCategory.FETCH_ERROR,
    code: isAborted ? SystemErrors.ABORTED : SystemErrors.FETCH_ERROR,
  };
}

function mapMcpToolError(error: ProtocolError, url: string): ToolErrorPayload {
  return {
    error: stripProtocolErrorPrefix(error.message),
    url,
    category: ErrorCategory.MCP_ERROR,
    code: error.code,
    statusCode: error.code,
    ...(error.data !== undefined ? { data: error.data } : {}),
  };
}

function resolveSdkErrorCategory(code: SdkErrorCode): string {
  switch (code) {
    case SdkErrorCode.ConnectionClosed:
      return ErrorCategory.UPSTREAM_ABORTED;
    case SdkErrorCode.RequestTimeout:
      return ErrorCategory.UPSTREAM_TIMEOUT;
    case SdkErrorCode.SendFailed:
      return ErrorCategory.FETCH_ERROR;
    default:
      return ErrorCategory.MCP_ERROR;
  }
}

function resolveToolErrorPayload(
  error: unknown,
  url: string,
  fallbackMessage: string
): ToolErrorPayload {
  if (error instanceof FetchError) {
    return mapFetchToolError(error, url);
  }

  if (error instanceof ProtocolError) {
    return mapMcpToolError(error, url);
  }

  if (error instanceof SdkError) {
    return {
      error: error.message,
      url,
      category: resolveSdkErrorCategory(error.code),
      code: error.code,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }

  return mapGenericToolError(error, url, fallbackMessage);
}

export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  return toToolErrorResponse(
    resolveToolErrorPayload(error, url, fallbackMessage)
  );
}

export function classifyAndLogToolError(
  error: unknown,
  meta: ToolErrorLogMeta,
  loggerName: string,
  toolName: string,
  fallbackMessage: string
): ToolErrorResponse {
  if (error instanceof ProtocolError) {
    if (error.code === (ProtocolErrorCode.MethodNotFound as number)) {
      logError(
        `${toolName} tool protocol error`,
        { url: meta.url, durationMs: meta.durationMs, error },
        loggerName
      );
      throw error;
    }
    logWarn(
      `${toolName} tool error`,
      { url: meta.url, durationMs: meta.durationMs, error },
      loggerName
    );
    return handleToolError(error, meta.url, fallbackMessage);
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
