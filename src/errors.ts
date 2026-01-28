import { isObject } from './type-guards.js';

const DEFAULT_HTTP_STATUS = 502;

export class FetchError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    readonly url: string,
    httpStatus?: number,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'FetchError';
    this.statusCode = httpStatus ?? DEFAULT_HTTP_STATUS;
    this.code = httpStatus ? `HTTP_${httpStatus}` : 'FETCH_ERROR';
    this.details = Object.freeze({ url, httpStatus, ...details });
    Error.captureStackTrace(this, this.constructor);
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  if (isErrorWithMessage(error)) return error.message;
  return 'Unknown error';
}

function isErrorWithMessage(error: unknown): error is { message: string } {
  if (!isObject(error)) return false;
  const { message } = error;
  return typeof message === 'string' && message.length > 0;
}

export function createErrorWithCode(
  message: string,
  code: string
): NodeJS.ErrnoException {
  const error = new Error(message);
  return Object.assign(error, { code });
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}
