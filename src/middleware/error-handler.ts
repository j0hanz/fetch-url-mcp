import type { NextFunction, Request, Response } from 'express';

import type { ErrorResponse } from '../config/types/tools.js';

import { FetchError } from '../errors/app-error.js';

import { logError } from '../services/logger.js';

function getStatusCode(err: Error): number {
  return err instanceof FetchError ? err.statusCode : 500;
}

function getErrorCode(err: Error): string {
  return err instanceof FetchError ? err.code : 'INTERNAL_ERROR';
}

function getErrorMessage(err: Error): string {
  return err instanceof FetchError ? err.message : 'Internal Server Error';
}

function getErrorDetails(err: Error): Record<string, unknown> | undefined {
  if (err instanceof FetchError && Object.keys(err.details).length > 0) {
    return err.details;
  }
  return undefined;
}

function setRetryAfterHeader(res: Response, err: Error): void {
  const retryAfter = resolveRetryAfter(err);
  if (!retryAfter) return;
  res.set('Retry-After', retryAfter);
}

function buildErrorResponse(err: Error): ErrorResponse {
  const details = getErrorDetails(err);
  const response: ErrorResponse = {
    error: {
      message: getErrorMessage(err),
      code: getErrorCode(err),
      statusCode: getStatusCode(err),
      ...(details && { details }),
    },
  };

  // Never expose stack traces in production
  return response;
}

function resolveRetryAfter(err: Error): string | null {
  if (!(err instanceof FetchError)) return null;
  if (err.statusCode !== 429) return null;

  const { retryAfter } = err.details;
  if (!isRetryAfterValue(retryAfter)) return null;
  return String(retryAfter);
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
  const statusCode = getStatusCode(err);

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

  setRetryAfterHeader(res, err);

  res.status(statusCode).json(buildErrorResponse(err));
}
