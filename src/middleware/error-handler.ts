import type { NextFunction, Request, Response } from 'express';

import type { ErrorResponse } from '../config/types/tools.js';

import { FetchError } from '../errors/app-error.js';

import { logError } from '../services/logger.js';

function getStatusCode(fetchError: FetchError | null): number {
  return fetchError ? fetchError.statusCode : 500;
}

function getErrorCode(fetchError: FetchError | null): string {
  return fetchError ? fetchError.code : 'INTERNAL_ERROR';
}

function getErrorMessage(fetchError: FetchError | null): string {
  return fetchError ? fetchError.message : 'Internal Server Error';
}

function getErrorDetails(
  fetchError: FetchError | null
): Record<string, unknown> | undefined {
  if (fetchError && Object.keys(fetchError.details).length > 0) {
    return fetchError.details;
  }
  return undefined;
}

function setRetryAfterHeader(
  res: Response,
  fetchError: FetchError | null
): void {
  const retryAfter = resolveRetryAfter(fetchError);
  if (retryAfter === undefined) return;
  res.set('Retry-After', retryAfter);
}

function buildErrorResponse(fetchError: FetchError | null): ErrorResponse {
  const details = getErrorDetails(fetchError);
  const response: ErrorResponse = {
    error: {
      message: getErrorMessage(fetchError),
      code: getErrorCode(fetchError),
      statusCode: getStatusCode(fetchError),
      ...(details && { details }),
    },
  };

  // Never expose stack traces in production
  return response;
}

function resolveRetryAfter(fetchError: FetchError | null): string | undefined {
  if (fetchError?.statusCode !== 429) return undefined;

  const { retryAfter } = fetchError.details;
  return isRetryAfterValue(retryAfter) ? String(retryAfter) : undefined;
}

function isRetryAfterValue(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'string';
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const fetchError = err instanceof FetchError ? err : null;
  const statusCode = getStatusCode(fetchError);

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

  setRetryAfterHeader(res, fetchError);

  res.status(statusCode).json(buildErrorResponse(fetchError));
}
