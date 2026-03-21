import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  hash as oneShotHash,
  timingSafeEqual,
} from 'node:crypto';
import {
  setInterval as setIntervalPromise,
  setTimeout as setTimeoutPromise,
} from 'node:timers/promises';
import { inspect } from 'node:util';

import { config, logDebug, logWarn } from './core.js';

const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

function getAbortReason(signal: AbortSignal): unknown {
  const record = isObject(signal) ? (signal as Record<string, unknown>) : null;
  return record && 'reason' in record ? record['reason'] : undefined;
}
function isTimeoutAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}
export function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  const reason = getAbortReason(signal);
  if (isTimeoutAbortReason(reason)) {
    throw new FetchError('Request timeout', url, 504, {
      reason: 'timeout',
      stage,
    });
  }

  throw new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}
export function createAbortError(url: string, stage: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}
const MAX_HASH_INPUT_BYTES = 5 * 1024 * 1024;
type AllowedHashAlgorithm = 'sha256' | 'sha512';
const ALLOWED_HASH_ALGORITHMS: ReadonlySet<AllowedHashAlgorithm> = new Set([
  'sha256',
  'sha512',
]);
function byteLengthUtf8(input: string): number {
  // Avoid allocating (unlike TextEncoder().encode()).
  return Buffer.byteLength(input, 'utf8');
}
function byteLength(input: string | Uint8Array): number {
  return typeof input === 'string' ? byteLengthUtf8(input) : input.byteLength;
}
function assertAllowedAlgorithm(
  algorithm: AllowedHashAlgorithm
): asserts algorithm is AllowedHashAlgorithm {
  // Defensive: protects against `any` / unchecked external inputs.
  if (!ALLOWED_HASH_ALGORITHMS.has(algorithm)) {
    throw new Error(`Hash algorithm not allowed: ${algorithm}`);
  }
}
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length === bBuffer.length) {
    return timingSafeEqual(aBuffer, bBuffer);
  }

  // If lengths differ, compare against a buffer of the same length filled with zeros.
  const maxLength = Math.max(aBuffer.length, bBuffer.length);
  const paddedA = Buffer.alloc(maxLength);
  aBuffer.copy(paddedA);
  const paddedB = Buffer.alloc(maxLength);
  bBuffer.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && aBuffer.length === bBuffer.length;
}
function hashHex(
  algorithm: AllowedHashAlgorithm,
  input: string | Uint8Array
): string {
  assertAllowedAlgorithm(algorithm);

  if (byteLength(input) <= MAX_HASH_INPUT_BYTES) {
    return oneShotHash(algorithm, input, 'hex');
  }

  const hasher = createHash(algorithm);
  hasher.update(input);
  return hasher.digest('hex');
}
export function sha256Hex(input: string | Uint8Array): string {
  return hashHex('sha256', input);
}
export function hmacSha256Hex(
  key: string | Uint8Array,
  input: string | Uint8Array
): string {
  return createHmac('sha256', key).update(input).digest('hex');
}
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
    this.code =
      typeof explicitCode === 'string'
        ? explicitCode
        : httpStatus
          ? `HTTP_${httpStatus}`
          : 'FETCH_ERROR';
  }
}
export function getErrorMessage(error: unknown): string {
  if (isError(error)) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  if (
    isObject(error) &&
    typeof error.message === 'string' &&
    error.message.length > 0
  ) {
    return error.message;
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
export function isAbortError(error: unknown): boolean {
  return isError(error) && error.name === 'AbortError';
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
const MAX_DEPTH = 20;
const CIRCULAR_ERROR = 'stableStringify: Circular reference detected';
export function stableStringify(obj: unknown): string {
  const seen = new WeakSet<object>();

  const process = (value: unknown, depth: number): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) {
      throw new Error(`stableStringify: Max depth (${MAX_DEPTH}) exceeded`);
    }
    if (seen.has(value)) {
      throw new Error(CIRCULAR_ERROR);
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        return value.map((item) => process(item, depth + 1));
      }

      const record = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = process(record[key], depth + 1);
      }
      return sorted;
    } finally {
      seen.delete(value);
    }
  };

  return JSON.stringify(process(obj, 0));
}
interface HttpServerTuningTarget {
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  keepAliveTimeoutBuffer?: number;
  maxHeadersCount?: number | null;
  maxConnections?: number;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}
const DROP_LOG_INTERVAL_MS = 10_000;
export function applyHttpServerTuning(server: HttpServerTuningTarget): void {
  const {
    headersTimeoutMs,
    requestTimeoutMs,
    keepAliveTimeoutMs,
    keepAliveTimeoutBufferMs,
    maxHeadersCount,
    maxConnections,
  } = config.server.http;

  if (headersTimeoutMs !== undefined) server.headersTimeout = headersTimeoutMs;
  if (requestTimeoutMs !== undefined) server.requestTimeout = requestTimeoutMs;
  if (keepAliveTimeoutMs !== undefined)
    server.keepAliveTimeout = keepAliveTimeoutMs;
  if (keepAliveTimeoutBufferMs !== undefined)
    server.keepAliveTimeoutBuffer = keepAliveTimeoutBufferMs;
  if (maxHeadersCount !== undefined) server.maxHeadersCount = maxHeadersCount;

  if (typeof maxConnections === 'number' && maxConnections > 0) {
    server.maxConnections = maxConnections;

    if (typeof server.on === 'function') {
      let lastLoggedAt = 0;
      let droppedSinceLastLog = 0;

      const onDrop = (data: unknown): void => {
        droppedSinceLastLog += 1;
        const now = Date.now();
        if (now - lastLoggedAt < DROP_LOG_INTERVAL_MS) return;

        logWarn('Incoming connection dropped (maxConnections reached)', {
          maxConnections,
          dropped: droppedSinceLastLog,
          data,
        });

        lastLoggedAt = now;
        droppedSinceLastLog = 0;
      };

      server.on('drop', onDrop);
    }
  }
}
export function drainConnectionsOnShutdown(
  server: HttpServerTuningTarget
): void {
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
    logDebug('Closed idle HTTP connections during shutdown');
  }
}
export interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel: () => void;
}
interface IntervalLoopOptions<T> {
  signal: AbortSignal;
  onTick: (value: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
}
function createAbortSafeTimeoutPromise<T>(
  timeoutMs: number,
  value: T,
  signal: AbortSignal
): Promise<T> {
  return setTimeoutPromise(timeoutMs, value, {
    ref: false,
    signal,
  }).catch((err: unknown) => {
    if (isAbortError(err)) {
      return new Promise<T>(() => {});
    }
    throw err;
  });
}
export function createUnrefTimeout<T>(
  timeoutMs: number,
  value: T
): CancellableTimeout<T> {
  const controller = new AbortController();
  const promise = createAbortSafeTimeoutPromise(
    timeoutMs,
    value,
    controller.signal
  );

  return {
    promise,
    cancel: () => {
      controller.abort();
    },
  };
}
export function startAbortableIntervalLoop<T>(
  intervalMs: number,
  value: T,
  options: IntervalLoopOptions<T>
): void {
  const ticks = setIntervalPromise(intervalMs, value, {
    signal: options.signal,
    ref: false,
  });

  void (async () => {
    try {
      for await (const tickValue of ticks) {
        await options.onTick(tickValue);
        if (options.signal.aborted) return;
      }
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      options.onError?.(error);
    }
  })();
}
export function isObject(
  value: unknown
): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isError(value: unknown): value is Error {
  const { isError: isErrorFn } = Error as {
    isError?: (err: unknown) => boolean;
  };
  return typeof isErrorFn === 'function'
    ? isErrorFn(value)
    : value instanceof Error;
}
interface LikeNode {
  readonly tagName?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly nodeType?: number | undefined;
  readonly textContent?: string | null | undefined;
  readonly innerHTML?: string | undefined;
  readonly parentNode?: unknown;
  readonly childNodes?: ArrayLike<unknown>;
  readonly rawTagName?: string | undefined;
  getAttribute?(name: string): string | null;
}
export function isLikeNode(value: unknown): value is LikeNode {
  return isObject(value);
}

export function withSignal(
  signal?: AbortSignal
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}
