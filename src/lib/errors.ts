import { inspect } from 'node:util';

import { isError, isObject } from './type-guards.js';

const DEFAULT_HTTP_STATUS = 502;

export class FetchError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    readonly url: string,
    httpStatus?: number,
    details: Record<string, unknown> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'FetchError';
    this.statusCode = httpStatus ?? DEFAULT_HTTP_STATUS;
    this.code = httpStatus ? `HTTP_${httpStatus}` : 'FETCH_ERROR';
    this.details = Object.freeze({ url, httpStatus, ...details });
    Error.captureStackTrace(this, this.constructor);
  }
}

export function getErrorMessage(error: unknown): string {
  if (isError(error)) return error.message;
  if (isNonEmptyString(error)) return error;
  if (isErrorWithMessage(error)) return error.message;
  return formatUnknownError(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isErrorWithMessage(error: unknown): error is { message: string } {
  if (!isObject(error)) return false;
  const { message } = error;
  return typeof message === 'string' && message.length > 0;
}

function formatUnknownError(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error';
  try {
    return inspect(error, {
      depth: 2,
      maxStringLength: 200,
      breakLength: Infinity,
      compact: true,
      colors: false,
    });
  } catch {
    return 'Unknown error';
  }
}

export function createErrorWithCode(
  message: string,
  code: string,
  options?: ErrorOptions
): NodeJS.ErrnoException {
  const error = new Error(message, options);
  return Object.assign(error, { code });
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (!isError(error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}

export const RESOURCE_NOT_FOUND_ERROR_CODE = -32002;
