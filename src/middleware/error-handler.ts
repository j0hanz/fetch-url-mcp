import type { Request, Response } from 'express';

import type { ErrorResponse } from '../config/types.js';

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
  if (!(err instanceof FetchError)) return;
  if (err.statusCode !== 429) return;
  const { retryAfter } = err.details;
  if (retryAfter === undefined) return;
  if (typeof retryAfter === 'number' || typeof retryAfter === 'string') {
    res.set('Retry-After', String(retryAfter));
  }
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

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  return response;
}

export function errorHandler(err: Error, req: Request, res: Response): void {
  const statusCode = getStatusCode(err);

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

  setRetryAfterHeader(res, err);

  res.status(statusCode).json(buildErrorResponse(err));
}
