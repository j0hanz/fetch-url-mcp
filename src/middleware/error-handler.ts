import type { NextFunction, Request, Response } from 'express';

import type { ErrorResponse } from '../config/types.js';

import {
  AppError,
  RateLimitError,
  ValidationError,
} from '../errors/app-error.js';

import { logError } from '../services/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';
  const message =
    isAppError && err.isOperational ? err.message : 'Internal Server Error';

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

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

  // Ensure middleware chain ends here
  next();
}
