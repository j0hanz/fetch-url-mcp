/**
 * Base application error class with status code support
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    isOperational = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

/**
 * URL validation error (400)
 */
export class UrlValidationError extends AppError {
  public readonly url: string;

  constructor(message: string, url: string) {
    super(message, 400, 'INVALID_URL');
    this.url = url;
  }
}

/**
 * Fetch error - network/HTTP errors during URL fetching
 */
export class FetchError extends AppError {
  public readonly url: string;
  public readonly httpStatus?: number;

  constructor(message: string, url: string, httpStatus?: number) {
    super(message, httpStatus ?? 502, 'FETCH_ERROR');
    this.url = url;
    this.httpStatus = httpStatus;
  }
}

/**
 * Content extraction error
 */
export class ExtractionError extends AppError {
  public readonly url: string;

  constructor(message: string, url: string) {
    super(message, 422, 'EXTRACTION_ERROR');
    this.url = url;
  }
}

/**
 * Unauthorized error (401)
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * Forbidden error (403)
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Rate limit error (429)
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('Too many requests', 429, 'RATE_LIMITED');
    this.retryAfter = retryAfter;
  }
}

/**
 * Timeout error (408/504)
 */
export class TimeoutError extends AppError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number, isGateway = false) {
    super(
      `Request timeout after ${timeoutMs}ms`,
      isGateway ? 504 : 408,
      'TIMEOUT'
    );
    this.timeoutMs = timeoutMs;
  }
}
