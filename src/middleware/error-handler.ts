import type { Request, Response } from 'express';

import type { ErrorResponse } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

import { logError } from '../services/logger.js';

export function errorHandler(err: Error, req: Request, res: Response): void {
  const isFetchError = err instanceof FetchError;
  const statusCode = isFetchError ? err.statusCode : 500;
  const code = isFetchError ? err.code : 'INTERNAL_ERROR';
  const message = isFetchError ? err.message : 'Internal Server Error';

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

  if (isFetchError && err.statusCode === 429 && err.details.retryAfter) {
    const retryAfter = err.details.retryAfter as number;
    res.set('Retry-After', String(retryAfter));
  }

  const response: ErrorResponse = {
    error: {
      message,
      code,
      statusCode,
      ...(isFetchError &&
        Object.keys(err.details).length > 0 && { details: err.details }),
    },
  };

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
