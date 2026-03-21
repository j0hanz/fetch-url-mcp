import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  hash as oneShotHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  setInterval as setIntervalPromise,
  setTimeout as setTimeoutPromise,
} from 'node:timers/promises';
import { inspect } from 'node:util';

import { config, logDebug, logWarn } from './core.js';

const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

export function composeAbortSignal(
  signal?: AbortSignal,
  timeoutMs?: number
): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (signal && timeoutSignal) {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal ?? timeoutSignal;
}

export function parseUrlOrNull(input: string, base?: string): URL | null {
  return URL.parse(input, base);
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
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
const TIMING_SAFE_HMAC_KEY = randomBytes(32);

export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const aHash = createHmac('sha256', TIMING_SAFE_HMAC_KEY).update(a).digest();
  const bHash = createHmac('sha256', TIMING_SAFE_HMAC_KEY).update(b).digest();
  return timingSafeEqual(aHash, bHash);
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
  return (
    (Error as { isError?: (v: unknown) => boolean }).isError?.(value) ??
    value instanceof Error
  );
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
