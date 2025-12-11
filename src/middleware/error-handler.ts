import type { Request, Response, NextFunction } from 'express';
import { logError } from '../services/logger.js';
import { AppError, RateLimitError, ValidationError } from '../errors/index.js';
import type { ErrorResponse } from '../config/types.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';
  const message =
    isAppError && err.isOperational ? err.message : 'Internal Server Error';

  logError(`HTTP ${statusCode}: ${err.message}`, err);

  if (err instanceof RateLimitError) {
    res.set('Retry-After', String(err.retryAfter));
  }

  const response: ErrorResponse = {
    error: {
      message,
      code,
      statusCode,
    },
  };

  if (err instanceof ValidationError && err.details) {
    response.error.details = err.details;
  }

  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
