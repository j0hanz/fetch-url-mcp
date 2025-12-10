import type { Request, Response, NextFunction } from 'express';
import { logError } from '../services/logger.js';
import { AppError, RateLimitError, ValidationError } from '../errors/index.js';

interface ErrorResponse {
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: Record<string, unknown>;
    stack?: string;
  };
}

/**
 * Error handling middleware for Express
 * Note: Express error handlers require 4 parameters
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Determine error properties
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';
  const message =
    isAppError && err.isOperational ? err.message : 'Internal Server Error';

  // Log error (full details for non-operational errors)
  logError(`HTTP ${statusCode}: ${err.message}`, err);

  // Add retry-after header for rate limit errors
  if (err instanceof RateLimitError) {
    res.set('Retry-After', String(err.retryAfter));
  }

  // Build error response
  const response: ErrorResponse = {
    error: {
      message,
      code,
      statusCode,
    },
  };

  // Add validation details if present
  if (err instanceof ValidationError && err.details) {
    response.error.details = err.details;
  }

  // Add stack trace in development
  if (process.env.NODE_ENV === 'development') {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
