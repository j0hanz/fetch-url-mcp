import { inspect } from 'node:util';

import { isObject } from '../utils.js';
import { SystemErrors } from './codes.js';

// ── Error identity ─────────────────────────────────────────────────

type ErrorConstructorWithIsError = ErrorConstructor & {
  isError?: (value: unknown) => boolean;
};

export function isError(value: unknown): value is Error {
  const maybeIsError = (Error as ErrorConstructorWithIsError).isError;
  if (typeof maybeIsError === 'function') {
    const result = maybeIsError(value);
    if (typeof result === 'boolean') return result;
  }

  return value instanceof Error;
}

// ── Error classes ──────────────────────────────────────────────────

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
    this.details = Object.freeze({ url, httpStatus, ...details });
    const explicitCode = this.details['code'];
    if (typeof explicitCode === 'string') {
      this.code = explicitCode;
    } else if (httpStatus) {
      this.code = `HTTP_${httpStatus}`;
    } else {
      this.code = SystemErrors.FETCH_ERROR;
    }
  }
}

export class CodedError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'CodedError';
  }
}

// ── Error guards ───────────────────────────────────────────────────

export function isAbortError(error: unknown): boolean {
  return isError(error) && error.name === 'AbortError';
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (!isError(error)) return false;
  if (!('code' in error)) return false;
  const { code } = error;
  return typeof code === 'string';
}

// ── Error extraction ───────────────────────────────────────────────

const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

export function getErrorMessage(error: unknown): string {
  if (isError(error)) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  if (
    isObject(error) &&
    typeof error['message'] === 'string' &&
    error['message'].length > 0
  ) {
    return error['message'];
  }
  if (error === null || error === undefined) return UNKNOWN_ERROR_MESSAGE;
  try {
    return inspect(error, {
      depth: 2,
      maxStringLength: 200,
      breakLength: Infinity,
      compact: true,
      colors: false,
    });
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
}

export function toError(error: unknown): Error {
  return isError(error) ? error : new Error(getErrorMessage(error));
}

// ── Abort helpers ──────────────────────────────────────────────────

export function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
    const error = new FetchError('Request timeout', url, 504, {
      reason: 'timeout',
      stage,
    });
    throw error;
  }

  throw createAbortError(url, stage);
}

export function createAbortError(url: string, stage: string): FetchError {
  const error = new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
  return error;
}
