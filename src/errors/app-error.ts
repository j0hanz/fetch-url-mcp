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

export class ValidationError extends AppError {
  public readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class UrlValidationError extends AppError {
  public readonly url: string;

  constructor(message: string, url: string) {
    super(message, 400, 'INVALID_URL');
    this.url = url;
  }
}

export class FetchError extends AppError {
  public readonly url: string;
  public readonly httpStatus: number | undefined;

  constructor(message: string, url: string, httpStatus?: number) {
    super(message, httpStatus ?? 502, 'FETCH_ERROR');
    this.url = url;
    this.httpStatus = httpStatus;
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('Too many requests', 429, 'RATE_LIMITED');
    this.retryAfter = retryAfter;
  }
}

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
