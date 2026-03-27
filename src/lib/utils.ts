import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  setInterval as setIntervalPromise,
  setTimeout as setTimeoutPromise,
} from 'node:timers/promises';
import { inspect } from 'node:util';

import { config, logDebug, logWarn } from './core.js';

const textEncoder = new TextEncoder();
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

  throw createAbortError(url, stage);
}
export function createAbortError(url: string, stage: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const aBuf = textEncoder.encode(a);
  const bBuf = textEncoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return timingSafeEqual(aBuf, bBuf);
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
    if (typeof explicitCode === 'string') {
      this.code = explicitCode;
    } else if (httpStatus) {
      this.code = `HTTP_${httpStatus}`;
    } else {
      this.code = 'FETCH_ERROR';
    }
  }
}
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
  const { code } = error;
  return typeof code === 'string';
}
interface TunableHttpServer {
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  keepAliveTimeoutBuffer?: number;
  maxHeadersCount?: number | null;
  maxConnections?: number;
  dropMaxConnection?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}
const DROP_LOG_INTERVAL_MS = 10_000;
export function applyHttpServerTuning(server: TunableHttpServer): void {
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
    server.dropMaxConnection = true;

    if (typeof server.on === 'function') {
      let lastLoggedAt = 0;
      let droppedSinceLastLog = 0;

      const onDrop = (data: unknown): void => {
        droppedSinceLastLog += 1;
        const now = Date.now();
        if (now - lastLoggedAt < DROP_LOG_INTERVAL_MS) return;

        logWarn(
          'Incoming connection dropped (maxConnections reached)',
          {
            maxConnections,
            dropped: droppedSinceLastLog,
            data,
          },
          'http'
        );

        lastLoggedAt = now;
        droppedSinceLastLog = 0;
      };

      server.on('drop', onDrop);
    }
  }
}
export function drainConnectionsOnShutdown(server: TunableHttpServer): void {
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
    logDebug('Closed idle HTTP connections during shutdown', undefined, 'http');
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
interface HtmlNode {
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
export function isHtmlNode(value: unknown): value is HtmlNode {
  return (
    isObject(value) &&
    ('nodeType' in value || 'nodeName' in value || 'tagName' in value)
  );
}

export function withSignal(
  signal?: AbortSignal
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}

export const CharCode = {
  TAB: 9,
  LF: 10,
  FF: 12,
  CR: 13,
  SPACE: 32,
  EXCLAMATION: 33,
  SLASH: 47,
  PERIOD: 46,
  QUESTION: 63,
  COLON: 58,
  SEMICOLON: 59,
  A_UPPER: 65,
  Z_UPPER: 90,
  A_LOWER: 97,
  Z_LOWER: 122,
  DOUBLE_QUOTE: 34,
  SINGLE_QUOTE: 39,
  RIGHT_PAREN: 41,
  RIGHT_BRACKET: 93,
  BACKTICK: 96,
} as const;

export function isWhitespaceChar(code: number): boolean {
  return (
    code === CharCode.TAB ||
    code === CharCode.LF ||
    code === CharCode.FF ||
    code === CharCode.CR ||
    code === CharCode.SPACE
  );
}

export function getUtf8ByteLength(html: string): number {
  return Buffer.byteLength(html, 'utf8');
}

const UTF8_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
const UTF8_2_BYTE = 0xc0;
const UTF8_3_BYTE = 0xe0;
const UTF8_4_BYTE = 0xf0;
const UTF8_5_BYTE = 0xf8; // Limits 4-byte validity check

export function trimUtf8Buffer(
  buffer: Uint8Array,
  maxBytes: number
): Uint8Array {
  if (buffer.length <= maxBytes) return buffer;
  if (maxBytes <= 0) return buffer.subarray(0, 0);

  let end = maxBytes;
  let cursor = end - 1;

  while (
    cursor >= 0 &&
    ((buffer[cursor] ?? 0) & UTF8_MASK) === UTF8_CONTINUATION
  ) {
    cursor -= 1;
  }

  if (cursor < 0) return buffer.subarray(0, maxBytes);

  const lead = buffer[cursor] ?? 0;
  let sequenceLength = 1;

  if (lead >= UTF8_2_BYTE && lead < UTF8_3_BYTE) sequenceLength = 2;
  else if (lead >= UTF8_3_BYTE && lead < UTF8_4_BYTE) sequenceLength = 3;
  else if (lead >= UTF8_4_BYTE && lead < UTF8_5_BYTE) sequenceLength = 4;

  if (cursor + sequenceLength > end) {
    end = cursor;
  }

  return buffer.subarray(0, end);
}

const MAX_ENTITY_LENGTH = 10;

export function trimDanglingTagFragment(content: string): string {
  let result = content;

  // Trim dangling HTML entity (e.g. "&amp" cut before ";")
  const lastAmp = result.lastIndexOf('&');
  if (lastAmp !== -1 && lastAmp > result.length - MAX_ENTITY_LENGTH) {
    const tail = result.slice(lastAmp + 1);
    if (!tail.includes(';') && /^[#a-zA-Z][a-zA-Z0-9]*$/.test(tail)) {
      result = result.substring(0, lastAmp);
    }
  }

  const lastOpen = result.lastIndexOf('<');
  const lastClose = result.lastIndexOf('>');
  if (lastOpen > lastClose) {
    if (lastOpen === result.length - 1) {
      return result.substring(0, lastOpen);
    }
    const code = result.codePointAt(lastOpen + 1);
    if (
      code !== undefined &&
      (code === CharCode.SLASH ||
        code === CharCode.EXCLAMATION ||
        code === CharCode.QUESTION ||
        (code >= CharCode.A_UPPER && code <= CharCode.Z_UPPER) ||
        (code >= CharCode.A_LOWER && code <= CharCode.Z_LOWER))
    ) {
      return result.substring(0, lastOpen);
    }
  }
  return result;
}

export function isAsciiOnly(s: string, sampleSize = 512): boolean {
  const len = Math.min(s.length, sampleSize);
  for (let i = 0; i < len; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

export function truncateToUtf8Boundary(html: string, maxBytes: number): string {
  const htmlBuffer = new TextEncoder().encode(html.slice(0, maxBytes));
  return trimDanglingTagFragment(
    new TextDecoder('utf-8').decode(trimUtf8Buffer(htmlBuffer, maxBytes))
  );
}
export interface IconInfo {
  src: string;
  mimeType: string;
}

export function buildOptionalIcons(
  iconInfo?: IconInfo
): { icons: IconInfo[] } | Record<string, never> {
  if (!iconInfo) return {};
  return {
    icons: [
      {
        src: iconInfo.src,
        mimeType: iconInfo.mimeType,
      },
    ],
  };
}
