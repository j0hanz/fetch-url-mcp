import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { type ReadableStream as NodeReadableStream } from 'node:stream/web';
import tls from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { Agent, type Dispatcher } from 'undici';

import {
  config,
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  redactUrl,
} from './core.js';
import {
  FetchError,
  isAbortError,
  isError,
  isSystemError,
  toError,
} from './error-classes.js';
import { SystemErrors } from './error-codes.js';
import {
  invalidRedirectError,
  redirectCredentialsError,
  unsupportedProtocolError,
} from './error-messages.js';
import { Loggers } from './logger-names.js';
import { isIP } from './url.js';
import {
  BLOCKED_HOST_SUFFIXES,
  createDnsPreflight,
  IpBlocker,
  type Logger,
  RawUrlTransformer,
  SafeDnsResolver,
  type TransformResult,
  UrlNormalizer,
} from './url.js';
import { composeAbortSignal, isObject } from './utils.js';

// ═══════════════════════════════════════════════════════════════════
// ENCODING DETECTION
// ═══════════════════════════════════════════════════════════════════

function getCharsetFromContentType(
  contentType: string | null
): string | undefined {
  if (!contentType) return undefined;
  const match = /charset=([^;]+)/i.exec(contentType);
  const charsetGroup = match?.[1];

  if (!charsetGroup) return undefined;
  let charset = charsetGroup.trim();
  if (charset.startsWith('"') && charset.endsWith('"')) {
    charset = charset.slice(1, -1);
  }
  return charset.trim();
}
const MAX_CACHED_DECODERS = 50;
const decoderCache = new Map<string, TextDecoder>();
function createDecoder(encoding: string | undefined): TextDecoder {
  const label = normalizeEncodingLabel(encoding) || 'utf-8';
  const cached = decoderCache.get(label);
  if (cached) return cached;

  try {
    const decoder = new TextDecoder(label);
    if (decoderCache.size < MAX_CACHED_DECODERS) {
      decoderCache.set(label, decoder);
    }
    return decoder;
  } catch {
    const fallback = decoderCache.get('utf-8') ?? new TextDecoder('utf-8');
    if (decoderCache.size < MAX_CACHED_DECODERS) {
      decoderCache.set('utf-8', fallback);
    }
    return fallback;
  }
}
function decodeBuffer(buffer: Uint8Array, encoding: string): string {
  return createDecoder(encoding).decode(buffer);
}
function normalizeEncodingLabel(encoding: string | undefined): string {
  return encoding?.trim().toLowerCase() ?? '';
}
function isUnicodeWideEncoding(encoding: string | undefined): boolean {
  const normalized = normalizeEncodingLabel(encoding);
  return (
    normalized.startsWith('utf-16') ||
    normalized.startsWith('utf-32') ||
    normalized === 'ucs-2' ||
    normalized === 'unicodefffe' ||
    normalized === 'unicodefeff'
  );
}
const BOM_ENTRIES: readonly { bytes: readonly number[]; encoding: string }[] = [
  // 4-byte BOMs must come before shorter prefixes to avoid false matches
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];
function createSignatureMap<T>(
  entries: readonly T[],
  getKey: (entry: T) => number | undefined
): Map<number, readonly T[]> {
  const map = new Map<number, readonly T[]>();
  for (const entry of entries) {
    const key = getKey(entry);
    if (key === undefined) continue;
    const existing = map.get(key);
    map.set(key, existing ? [...existing, entry] : [entry]);
  }
  return map;
}
const BOM_BY_FIRST_BYTE = createSignatureMap(BOM_ENTRIES, (e) => e.bytes[0]);
function startsWithBytes(
  buffer: Uint8Array,
  signature: readonly number[]
): boolean {
  const sigLen = signature.length;
  if (buffer.length < sigLen) return false;

  for (let i = 0; i < sigLen; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}
function detectBomEncoding(buffer: Uint8Array): string | undefined {
  if (buffer.length === 0) return undefined;
  const first = buffer[0];
  if (first === undefined) return undefined;
  const candidates = BOM_BY_FIRST_BYTE.get(first);
  if (!candidates) return undefined;
  for (const { bytes, encoding } of candidates) {
    if (startsWithBytes(buffer, bytes)) return encoding;
  }
  return undefined;
}
function readQuotedValue(input: string, startIndex: number): string {
  const first = input[startIndex];
  if (!first) return '';

  const quoted = first === '"' || first === "'";
  if (quoted) {
    const end = input.indexOf(first, startIndex + 1);
    return end === -1 ? '' : input.slice(startIndex + 1, end).trim();
  }

  const tail = input.slice(startIndex);
  const stop = tail.search(/[\s/>]/);
  return (stop === -1 ? tail : tail.slice(0, stop)).trim();
}
function findTokenValue(
  original: string,
  lower: string,
  token: string,
  fromIndex = 0
): string | undefined {
  const tokenIndex = lower.indexOf(token, fromIndex);
  if (tokenIndex === -1) return undefined;

  const valueStart = tokenIndex + token.length;
  const value = readQuotedValue(original, valueStart);
  return value || undefined;
}
function extractHtmlCharset(headSnippet: string): string | undefined {
  const lower = headSnippet.toLowerCase();
  const charset = findTokenValue(headSnippet, lower, 'charset=');
  return charset ? charset.toLowerCase() : undefined;
}
function extractXmlEncoding(headSnippet: string): string | undefined {
  const lower = headSnippet.toLowerCase();
  const xmlStart = lower.indexOf('<?xml');
  if (xmlStart === -1) return undefined;

  const xmlEnd = lower.indexOf('?>', xmlStart);
  const declaration =
    xmlEnd === -1
      ? headSnippet.slice(xmlStart)
      : headSnippet.slice(xmlStart, xmlEnd + 2);
  const declarationLower = declaration.toLowerCase();

  const encoding = findTokenValue(declaration, declarationLower, 'encoding=');
  return encoding ? encoding.toLowerCase() : undefined;
}
function detectHtmlDeclaredEncoding(buffer: Uint8Array): string | undefined {
  const scanSize = Math.min(buffer.length, ENCODING_SCAN_LIMIT);
  if (scanSize === 0) return undefined;

  const headSnippet = createDecoder('latin1').decode(
    buffer.subarray(0, scanSize)
  );

  return extractHtmlCharset(headSnippet) ?? extractXmlEncoding(headSnippet);
}
function resolveEncoding(
  declared: string | undefined,
  sample: Uint8Array
): string {
  const bomEncoding = detectBomEncoding(sample);
  if (bomEncoding) return bomEncoding;

  if (declared) return declared;

  return detectHtmlDeclaredEncoding(sample) ?? 'utf-8';
}

// ═══════════════════════════════════════════════════════════════════
// BINARY DETECTION
// ═══════════════════════════════════════════════════════════════════

const ENCODING_SCAN_LIMIT = 8_192;
const BINARY_SCAN_LIMIT = 8_192;
const BINARY_NULL_CHECK_LIMIT = 1_000;

const BINARY_SIGNATURES = [
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0xff, 0xd8, 0xff], // JPEG
  [0x52, 0x49, 0x46, 0x46], // RIFF (WebP/AVI/WAV)
  [0x42, 0x4d], // BMP
  [0x49, 0x49, 0x2a, 0x00], // TIFF (little-endian)
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF (big-endian)
  [0x00, 0x00, 0x01, 0x00], // ICO
  [0x50, 0x4b, 0x03, 0x04], // ZIP/XLSX/DOCX
  [0x1f, 0x8b], // GZIP
  [0x42, 0x5a, 0x68], // BZIP2
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x37, 0x7a, 0xbc, 0xaf], // 7-Zip
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE/MZ (Windows executable)
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly
  [0x1a, 0x45, 0xdf, 0xa3], // MKV/WebM (EBML)
  [0x66, 0x74, 0x79, 0x70], // MP4/MOV (ftyp)
  [0x46, 0x4c, 0x56], // FLV
  [0x49, 0x44, 0x33], // MP3 (ID3 tag)
  [0xff, 0xfb], // MP3 (sync frame)
  [0xff, 0xfa], // MP3 (sync frame, alt)
  [0x4f, 0x67, 0x67, 0x53], // OGG
  [0x66, 0x4c, 0x61, 0x43], // FLAC
  [0x4d, 0x54, 0x68, 0x64], // MIDI
  [0x77, 0x4f, 0x46, 0x46], // WOFF
  [0x00, 0x01, 0x00, 0x00], // TrueType font
  [0x4f, 0x54, 0x54, 0x4f], // OpenType font
  [0x53, 0x51, 0x4c, 0x69], // SQLite
] as const;
const BINARY_SIG_BY_FIRST_BYTE = createSignatureMap(
  BINARY_SIGNATURES,
  (sig) => sig[0]
);
function hasNullByte(buffer: Uint8Array, limit: number): boolean {
  const checkLen = Math.min(buffer.length, limit);
  return buffer.subarray(0, checkLen).includes(0x00);
}
function hasBinarySignature(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return false;
  const first = buffer[0];
  if (first === undefined) return false;
  const candidates = BINARY_SIG_BY_FIRST_BYTE.get(first);
  if (!candidates) return false;
  for (const signature of candidates) {
    if (startsWithBytes(buffer, signature)) return true;
  }
  return false;
}
function isBinaryContent(buffer: Uint8Array, encoding?: string): boolean {
  if (hasBinarySignature(buffer)) return true;

  if (isUnicodeWideEncoding(encoding)) return false;

  const sample =
    buffer.length > BINARY_SCAN_LIMIT
      ? buffer.subarray(0, BINARY_SCAN_LIMIT)
      : buffer;
  if (isUtf8(sample)) return false;

  return hasNullByte(buffer, BINARY_SCAN_LIMIT);
}
function createBinaryContentError(url: string): FetchError {
  const error = new FetchError('Binary content detected', url, 500, {
    reason: 'binary_content_detected',
  });
  return error;
}

// ═══════════════════════════════════════════════════════════════════
// FETCH ERRORS
// ═══════════════════════════════════════════════════════════════════

function parseRetryAfter(header: string | null): number {
  if (!header) return 60;

  const trimmed = header.trim();

  // Retry-After can be seconds or an HTTP-date.
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds;

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 60;

  const deltaMs = dateMs - Date.now();
  if (deltaMs <= 0) return 0;

  return Math.ceil(deltaMs / 1000);
}
type FetchErrorInput =
  | { kind: 'canceled' }
  | { kind: 'aborted' }
  | { kind: 'timeout'; timeout: number }
  | { kind: 'rate-limited'; retryAfter: string | null }
  | { kind: 'http'; status: number; statusText: string }
  | { kind: 'too-many-redirects' }
  | { kind: 'missing-redirect-location' }
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; message?: string };
function createFetchError(input: FetchErrorInput, url: string): FetchError {
  switch (input.kind) {
    case 'canceled': {
      const error = new FetchError('Request canceled', url, 499, {
        reason: 'aborted',
      });
      return error;
    }
    case 'aborted': {
      const error = new FetchError(
        'Request aborted during response read',
        url,
        499,
        {
          reason: 'aborted',
        }
      );
      return error;
    }
    case 'timeout': {
      const error = new FetchError(
        `Request timed out after ${input.timeout}ms`,
        url,
        504,
        { timeout: input.timeout }
      );
      return error;
    }
    case 'rate-limited': {
      const error = new FetchError('Too many requests', url, 429, {
        retryAfter: parseRetryAfter(input.retryAfter),
      });
      return error;
    }
    case 'http': {
      const error = new FetchError(
        `HTTP ${input.status}: ${input.statusText}`,
        url,
        input.status
      );
      return error;
    }
    case 'too-many-redirects': {
      const error = new FetchError('Too many redirects', url);
      return error;
    }
    case 'missing-redirect-location': {
      const error = new FetchError('Redirect missing Location header', url);
      return error;
    }
    case 'network': {
      const error = new FetchError('Network error', url, undefined, {
        message: input.message,
      });
      return error;
    }
    case 'unknown': {
      const error = new FetchError(input.message ?? 'Unexpected error', url);
      return error;
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}
function isTimeoutError(error: unknown): boolean {
  return isError(error) && error.name === 'TimeoutError';
}
function resolveErrorUrl(error: unknown, fallback: string): string {
  if (error instanceof FetchError) return error.url;
  if (!isObject(error)) return fallback;

  const { requestUrl } = error;
  return typeof requestUrl === 'string' ? requestUrl : fallback;
}
const CLIENT_ERROR_CODES = new Set<string>([
  SystemErrors.VALIDATION_ERROR,
  SystemErrors.EBADREDIRECT,
  SystemErrors.EBLOCKED,
  SystemErrors.ENODATA,
  SystemErrors.EINVAL,
]);

function mapAbortError(
  error: unknown,
  timeoutMs: number,
  url: string
): FetchError {
  return isTimeoutError(error)
    ? createFetchError({ kind: 'timeout', timeout: timeoutMs }, url)
    : createFetchError({ kind: 'canceled' }, url);
}

function mapSystemError(error: NodeJS.ErrnoException, url: string): FetchError {
  const { code, message } = error;

  if (code === SystemErrors.ETIMEOUT) {
    const fetchError = new FetchError(message, url, 504, { code });
    return fetchError;
  }

  if (code && CLIENT_ERROR_CODES.has(code)) {
    const fetchError = new FetchError(message, url, 400, { code });
    return fetchError;
  }

  return createFetchError({ kind: 'network', message }, url);
}

function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error) || isTimeoutError(error)) {
    return mapAbortError(error, timeoutMs, url);
  }

  if (!isError(error)) {
    return createFetchError(
      { kind: 'unknown', message: 'Unexpected error' },
      url
    );
  }

  if (isSystemError(error)) {
    return mapSystemError(error, url);
  }

  const causeStr =
    error.cause instanceof Error ? error.cause.message : String(error.cause);
  return createFetchError(
    { kind: 'network', message: `${error.message}. Cause: ${causeStr}` },
    url
  );
}

// ═══════════════════════════════════════════════════════════════════
// REDIRECT FOLLOWING
// ═══════════════════════════════════════════════════════════════════

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}
function cancelResponseBody(response: Response): void {
  const cancelPromise = response.body?.cancel();
  if (!cancelPromise) return;

  void cancelPromise.catch(() => undefined);
}
class MaxBytesError extends Error {
  constructor() {
    super('max-bytes-reached');
  }
}
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;
type NormalizeUrl = (urlString: string) => string;
type RedirectPreflight = (url: string, signal?: AbortSignal) => Promise<string>;
function createPinnedAgent(ipAddress: string): Agent {
  const ca = tls.rootCertificates.length > 0 ? tls.rootCertificates : undefined;
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const family = isIP(ipAddress) === 6 ? 6 : 4;
        if (options.all) {
          callback(null, [{ address: ipAddress, family }]);
        } else {
          callback(null, ipAddress, family);
        }
      },
      timeout: config.fetcher.timeout,
      ...(ca ? { ca } : {}),
    },
    pipelining: 1,
    connections: 1,
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 1000,
  });
  return agent;
}
class RedirectFollower {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly normalizeUrl: NormalizeUrl,
    private readonly preflight?: RedirectPreflight
  ) {}

  async fetchWithRedirects(
    url: string,
    init: RequestInit,
    maxRedirects: number
  ): Promise<{ response: Response; url: string; agent?: Agent }> {
    let currentUrl = url;
    const redirectLimit = Math.max(0, maxRedirects);
    const visited = new Set<string>();

    for (
      let redirectCount = 0;
      redirectCount <= redirectLimit;
      redirectCount += 1
    ) {
      if (visited.has(currentUrl)) {
        throw createFetchError({ kind: 'too-many-redirects' }, currentUrl);
      }
      visited.add(currentUrl);

      const {
        response,
        nextUrl,
        agent: returnedAgent,
      } = await this.withRedirectErrorContext(currentUrl, async () => {
        let ipAddress: string | undefined;
        if (this.preflight) {
          ipAddress = await this.preflight(
            currentUrl,
            init.signal ?? undefined
          );
        }
        return this.performFetchCycle(
          currentUrl,
          init,
          redirectLimit,
          redirectCount,
          ipAddress
        );
      });

      if (!nextUrl) {
        return {
          response,
          url: currentUrl,
          ...(returnedAgent ? { agent: returnedAgent } : {}),
        };
      }
      currentUrl = nextUrl;
    }

    throw createFetchError({ kind: 'too-many-redirects' }, currentUrl);
  }

  private async performFetchCycle(
    currentUrl: string,
    init: RequestInit,
    redirectLimit: number,
    redirectCount: number,
    ipAddress?: string
  ): Promise<{ response: Response; nextUrl?: string; agent?: Agent }> {
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      ...init,
      redirect: 'manual' as RequestRedirect,
    };
    let agent: Agent | undefined;
    if (ipAddress) {
      agent = createPinnedAgent(ipAddress);
      fetchInit.dispatcher = agent;
    }

    let closeAgent = true;
    try {
      const response = await this.fetchFn(currentUrl, fetchInit);
      // Only follow redirects if the status code indicates a redirect and there's a Location header.
      if (!isRedirectStatus(response.status)) {
        closeAgent = false;
        return { response, ...(agent ? { agent } : {}) };
      }

      if (redirectCount >= redirectLimit) {
        cancelResponseBody(response);
        throw createFetchError({ kind: 'too-many-redirects' }, currentUrl);
      }

      const location = this.getRedirectLocation(response, currentUrl);
      cancelResponseBody(response);

      const nextUrl = this.resolveRedirectTarget(currentUrl, location);
      this.assertHttpProtocol(nextUrl);

      return {
        response,
        nextUrl,
      };
    } finally {
      if (closeAgent) {
        await agent?.close();
      }
    }
  }

  private getRedirectLocation(response: Response, currentUrl: string): string {
    const location = response.headers.get('location');
    if (location) return location;

    cancelResponseBody(response);
    throw createFetchError({ kind: 'missing-redirect-location' }, currentUrl);
  }

  private resolveRedirectTarget(baseUrl: string, location: string): string {
    const resolved = URL.parse(location, baseUrl);
    if (!resolved) {
      throw invalidRedirectError();
    }
    if (resolved.username || resolved.password) {
      throw redirectCredentialsError();
    }

    return this.normalizeUrl(resolved.href);
  }

  private annotateRedirectError(error: unknown, url: string): void {
    if (!isObject(error)) return;
    error['requestUrl'] = url;
  }

  private assertHttpProtocol(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw unsupportedProtocolError(parsed.protocol);
    }
  }

  private async withRedirectErrorContext<T>(
    url: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      this.annotateRedirectError(error, url);
      throw error;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// CONTENT VALIDATION & DECOMPRESSION
// ═══════════════════════════════════════════════════════════════════

function resolveResponseError(
  response: Response,
  finalUrl: string
): FetchError | null {
  if (response.status === 429) {
    return createFetchError(
      { kind: 'rate-limited', retryAfter: response.headers.get('retry-after') },
      finalUrl
    );
  }

  return response.ok
    ? null
    : createFetchError(
        {
          kind: 'http',
          status: response.status,
          statusText: response.statusText,
        },
        finalUrl
      );
}
function resolveMediaType(contentType: string | null): string | null {
  if (!contentType) return null;

  const semiIndex = contentType.indexOf(';');
  const mediaType =
    semiIndex === -1 ? contentType : contentType.slice(0, semiIndex);
  const trimmed = mediaType.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}
const TEXTUAL_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/markdown',
]);
function isTextLikeMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  if (TEXTUAL_MEDIA_TYPES.has(mediaType)) return true;
  return (
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml') ||
    mediaType.endsWith('+yaml') ||
    mediaType.endsWith('+text') ||
    mediaType.endsWith('+markdown')
  );
}
function assertSupportedContentType(
  contentType: string | null,
  url: string
): void {
  const mediaType = resolveMediaType(contentType);
  if (!mediaType) {
    logDebug(
      'No Content-Type header; relying on binary-content detection',
      {
        url: redactUrl(url),
      },
      Loggers.LOG_FETCH
    );
    return;
  }

  if (!isTextLikeMediaType(mediaType)) {
    const error = new FetchError(`Unsupported content type: ${mediaType}`, url);
    throw error;
  }
}
function extractEncodingTokens(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}
type ContentEncoding = 'gzip' | 'deflate' | 'br';
function parseContentEncodings(value: string | null): string[] | null {
  if (!value) return null;
  const tokens = extractEncodingTokens(value);
  if (tokens.length === 0) return null;
  return tokens;
}
function isSupportedContentEncoding(
  encoding: string
): encoding is ContentEncoding {
  return encoding === 'gzip' || encoding === 'deflate' || encoding === 'br';
}
function createUnsupportedContentEncodingError(
  url: string,
  encodingHeader: string
): FetchError {
  const error = new FetchError(
    `Unsupported Content-Encoding: ${encodingHeader}`,
    url,
    415,
    {
      reason: 'unsupported_content_encoding',
      encoding: encodingHeader,
    }
  );
  return error;
}
function createDecompressor(
  encoding: ContentEncoding
):
  | ReturnType<typeof createGunzip>
  | ReturnType<typeof createInflate>
  | ReturnType<typeof createBrotliDecompress> {
  const options = { chunkSize: 64 * 1024 };
  switch (encoding) {
    case 'gzip':
      return createGunzip(options);
    case 'deflate':
      return createInflate(options);
    case 'br':
      return createBrotliDecompress(options);
  }
}
function createPumpedStream(
  initialChunk: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initialChunk && initialChunk.byteLength > 0) {
        controller.enqueue(initialChunk);
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
  return stream;
}
interface DecodePipeline {
  decodedReader: ReadableStreamDefaultReader<Uint8Array>;
  decodedNodeStream: PassThrough;
  headers: Headers;
  cleanup: () => void;
}
function buildDecodePipeline(
  body: ReadableStream<Uint8Array>,
  encodings: ContentEncoding[],
  url: string,
  response: Response,
  signal?: AbortSignal
): DecodePipeline {
  const decodeOrder = encodings.slice().reverse();
  const decompressors = decodeOrder.map((enc) => createDecompressor(enc));
  const decodeSource = Readable.fromWeb(
    toNodeReadableStream(body, url, 'response:decode-content-encoding')
  );
  const decodedNodeStream = new PassThrough();
  const decodedPipeline = pipeline([
    decodeSource,
    ...decompressors,
    decodedNodeStream,
  ]);

  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');

  const cleanup = (): void => {
    decodeSource.destroy();
    for (const decompressor of decompressors) {
      decompressor.destroy();
    }
    decodedNodeStream.destroy();
  };

  if (signal) {
    signal.addEventListener('abort', cleanup, { once: true });
  }

  void decodedPipeline.catch((error: unknown) => {
    decodedNodeStream.destroy(toError(error));
  });

  const decodedBodyStream = toWebReadableStream(
    decodedNodeStream,
    url,
    'response:decode-content-encoding'
  );
  const decodedReader = decodedBodyStream.getReader();

  return {
    decodedReader,
    decodedNodeStream,
    headers,
    cleanup,
  };
}
function validateContentEncodings(
  parsedEncodings: string[],
  encodingHeader: string | null,
  url: string
): ContentEncoding[] {
  const encodings = parsedEncodings.filter(
    (token): token is ContentEncoding =>
      token !== 'identity' && isSupportedContentEncoding(token)
  );

  const unsupported = parsedEncodings.filter(
    (token) => token !== 'identity' && !isSupportedContentEncoding(token)
  );
  if (unsupported.length > 0) {
    throw createUnsupportedContentEncodingError(
      url,
      encodingHeader ?? unsupported.join(', ')
    );
  }

  return encodings;
}
async function primeDecodedResponse(
  pipe: DecodePipeline,
  response: Response,
  url: string,
  signal: AbortSignal | undefined
): Promise<Response> {
  const clearAbortListener = (): void => {
    if (!signal) return;
    signal.removeEventListener('abort', pipe.cleanup);
  };

  try {
    const first = await pipe.decodedReader.read();
    if (first.done) {
      clearAbortListener();
      const result = new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: pipe.headers,
      });
      return result;
    }

    const body = createPumpedStream(first.value, pipe.decodedReader);

    if (signal) {
      void finished(pipe.decodedNodeStream, { cleanup: true })
        .catch(() => {})
        .finally(() => {
          clearAbortListener();
        });
    }

    const result = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: pipe.headers,
    });
    return result;
  } catch (error: unknown) {
    clearAbortListener();
    pipe.cleanup();
    void pipe.decodedReader.cancel(error).catch(() => undefined);

    const fetchError = new FetchError(
      `Content-Encoding decode failed for ${redactUrl(url)}: ${isError(error) ? error.message : String(error)}`,
      url
    );
    throw fetchError;
  }
}
async function decodeResponseIfNeeded(
  response: Response,
  url: string,
  signal?: AbortSignal
): Promise<Response> {
  const encodingHeader = response.headers.get('content-encoding');
  const parsedEncodings = parseContentEncodings(encodingHeader);
  if (!parsedEncodings) return response;

  const encodings = validateContentEncodings(
    parsedEncodings,
    encodingHeader,
    url
  );

  if (encodings.length === 0 || !response.body) return response;

  const pipe = buildDecodePipeline(
    response.body,
    encodings,
    url,
    response,
    signal
  );

  return primeDecodedResponse(pipe, response, url, signal);
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE READING
// ═══════════════════════════════════════════════════════════════════

function assertNonBinaryContent(
  buffer: Uint8Array,
  encoding: string,
  url: string
): void {
  if (isBinaryContent(buffer, encoding)) {
    throw createBinaryContentError(url);
  }
}
interface ReaderOptions {
  url: string;
  maxBytes: number;
  signal?: AbortSignal | undefined;
  encoding?: string | undefined;
}
class ResponseTextReader {
  async read(
    response: Response,
    opts: ReaderOptions
  ): Promise<{ text: string; size: number; truncated: boolean }> {
    const {
      buffer,
      encoding: effectiveEncoding,
      truncated,
    } = await this.readBuffer(response, opts);

    const text = decodeBuffer(buffer, effectiveEncoding);
    return { text, size: buffer.byteLength, truncated };
  }

  async readBuffer(
    response: Response,
    opts: ReaderOptions
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    const { url, signal } = opts;
    if (signal?.aborted) {
      cancelResponseBody(response);
      throw createFetchError({ kind: 'aborted' }, url);
    }

    if (!response.body) {
      return this.readNonStreamBuffer(response, opts);
    }

    return this.readStreamToBuffer(response.body, opts);
  }

  private async readNonStreamBuffer(
    response: Response,
    opts: ReaderOptions
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    const { url, maxBytes, signal, encoding } = opts;
    if (signal?.aborted) throw createFetchError({ kind: 'canceled' }, url);

    const limit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!Number.isNaN(parsedLength) && parsedLength > limit) {
        throw createFetchError(
          {
            kind: 'network',
            message: `Payload too large (${parsedLength} bytes). Streaming is unavailable and response exceeds limit of ${limit} bytes.`,
          },
          url
        );
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const truncated = Number.isFinite(limit) && arrayBuffer.byteLength > limit;
    const length = truncated ? limit : arrayBuffer.byteLength;
    const buffer = new Uint8Array(arrayBuffer, 0, length);

    const effectiveEncoding = resolveEncoding(encoding, buffer);

    assertNonBinaryContent(buffer, effectiveEncoding, url);

    return {
      buffer,
      encoding: effectiveEncoding,
      size: buffer.byteLength,
      truncated,
    };
  }

  private async readStreamToBuffer(
    stream: ReadableStream<Uint8Array>,
    opts: ReaderOptions
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    const { url, maxBytes, signal, encoding } = opts;
    const byteLimit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;
    const captureChunks = byteLimit !== Number.POSITIVE_INFINITY;

    const source = Readable.fromWeb(
      toNodeReadableStream(stream, url, 'response:read-stream-buffer')
    );

    const chunks: Uint8Array[] = [];
    let total = 0;
    let effectiveEncoding = encoding ?? 'utf-8';
    let encodingResolved = false;
    let firstChunk = true;

    async function* guard(
      sourceIterable: AsyncIterable<Uint8Array>
    ): AsyncGenerator<Uint8Array, void, unknown> {
      for await (const chunk of sourceIterable) {
        const buf: Uint8Array =
          chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(chunk as ArrayBuffer);

        if (!encodingResolved) {
          encodingResolved = true;
          effectiveEncoding = resolveEncoding(encoding, buf);
        }

        if (
          (firstChunk && hasBinarySignature(buf)) ||
          (!isUnicodeWideEncoding(effectiveEncoding) &&
            hasNullByte(buf, BINARY_NULL_CHECK_LIMIT))
        ) {
          throw createBinaryContentError(url);
        }
        firstChunk = false;

        const newTotal = total + buf.length;
        if (newTotal > byteLimit) {
          const remaining = byteLimit - total;
          if (remaining > 0) {
            const slice = buf.subarray(0, remaining);
            total += remaining;
            yield slice;
          }
          const error = new MaxBytesError();
          throw error;
        }

        total = newTotal;
        yield buf;
      }
    }

    try {
      await pipeline(
        source,
        guard,
        async (iterable: AsyncIterable<Uint8Array>) => {
          for await (const chunk of iterable) {
            if (captureChunks) chunks.push(chunk);
          }
        },
        // Only pass `{ signal }` if signal exists to avoid type errors with exactOptionalPropertyTypes
        ...(signal ? [{ signal }] : [])
      );

      return {
        buffer: Buffer.concat(chunks, total),
        encoding: effectiveEncoding,
        size: total,
        truncated: false,
      };
    } catch (error: unknown) {
      if (signal?.aborted || isAbortError(error)) {
        throw createFetchError({ kind: 'aborted' }, url);
      }
      if (error instanceof FetchError) throw error;
      if (error instanceof MaxBytesError) {
        return {
          buffer: Buffer.concat(chunks, total),
          encoding: effectiveEncoding,
          size: total,
          truncated: true,
        };
      }
      throw error;
    }
  }
}
type ReadDecodedResponseResult =
  | {
      kind: 'text';
      text: string;
      size: number;
      truncated: boolean;
    }
  | {
      kind: 'buffer';
      buffer: Uint8Array;
      encoding: string;
      size: number;
      truncated: boolean;
    };
interface ReadDecodedOptions {
  response: Response;
  finalUrl: string;
  ctx: FetchTelemetryContext;
  telemetry: FetchTelemetry;
  reader: ResponseTextReader;
  maxBytes: number;
  mode: 'text' | 'buffer';
  signal?: AbortSignal;
}
async function readAndRecordDecodedResponse(
  opts: ReadDecodedOptions
): Promise<ReadDecodedResponseResult> {
  const { response, finalUrl, ctx, telemetry, reader, maxBytes, mode, signal } =
    opts;
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const contentType = response.headers.get('content-type');
  assertSupportedContentType(contentType, finalUrl);

  const declaredEncoding = getCharsetFromContentType(contentType ?? null);

  if (mode === 'text') {
    const { text, size, truncated } = await reader.read(response, {
      url: finalUrl,
      maxBytes,
      signal,
      encoding: declaredEncoding,
    });
    telemetry.recordResponse(ctx, response, size);
    return { kind: 'text', text, size, truncated };
  }

  const { buffer, encoding, size, truncated } = await reader.readBuffer(
    response,
    {
      url: finalUrl,
      maxBytes,
      signal,
      encoding: declaredEncoding,
    }
  );
  telemetry.recordResponse(ctx, response, size);
  return { kind: 'buffer', buffer, encoding, size, truncated };
}
type CompatibleReadableStream = ReadableStream<Uint8Array> &
  NodeReadableStream<Uint8Array>;
function isReadableStreamLike(
  value: unknown
): value is CompatibleReadableStream {
  if (!isObject(value)) return false;

  return (
    typeof value['getReader'] === 'function' &&
    typeof value['cancel'] === 'function' &&
    typeof value['tee'] === 'function' &&
    typeof value['locked'] === 'boolean'
  );
}
function assertReadableStreamLike(
  stream: unknown,
  url: string,
  stage: string
): asserts stream is CompatibleReadableStream {
  if (isReadableStreamLike(stream)) return;
  const error = new FetchError('Invalid response stream', url, 500, {
    reason: 'invalid_stream',
    stage,
  });
  throw error;
}
function toNodeReadableStream(
  stream: ReadableStream<Uint8Array>,
  url: string,
  stage: string
): NodeReadableStream<Uint8Array> {
  assertReadableStreamLike(stream, url, stage);
  return stream;
}
function toWebReadableStream(
  stream: Readable,
  url: string,
  stage: string
): ReadableStream<Uint8Array> {
  const converted: unknown = Readable.toWeb(stream);
  assertReadableStreamLike(converted, url, stage);
  return converted;
}

// ═══════════════════════════════════════════════════════════════════
// TELEMETRY
// ═══════════════════════════════════════════════════════════════════

interface RequestContextAccessor {
  getRequestId(): string | undefined;
  getOperationId(): string | undefined;
}
interface UrlRedactor {
  redact(url: string): string;
}
interface FetchStartEvent {
  v: 1;
  requestId: string;
  method: string;
  url: string;
  contextRequestId?: string;
  operationId?: string;
}

interface FetchEndEvent {
  v: 1;
  requestId: string;
  status: number;
  duration: number;
  contextRequestId?: string;
  operationId?: string;
}

interface FetchErrorEvent {
  v: 1;
  requestId: string;
  url: string;
  error: string;
  code?: string;
  status?: number;
  duration: number;
  contextRequestId?: string;
  operationId?: string;
}

const fetchChannels = diagnosticsChannel.tracingChannel('fetch-url-mcp.fetch');
interface FetchTelemetryContext {
  requestId: string;
  startTime: number;
  url: string;
  method: string;
  contextRequestId?: string;
  operationId?: string;
}
const SLOW_REQUEST_THRESHOLD_MS = 5000;
class FetchTelemetry {
  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContextAccessor,
    private readonly redactor: UrlRedactor
  ) {}

  redact(url: string): string {
    return this.redactor.redact(url);
  }

  private contextFields(
    ctx: FetchTelemetryContext
  ): Record<string, string | undefined> {
    return {
      ...(ctx.contextRequestId
        ? { contextRequestId: ctx.contextRequestId }
        : {}),
      ...(ctx.operationId ? { operationId: ctx.operationId } : {}),
    };
  }

  start(url: string, method: string): FetchTelemetryContext {
    const safeUrl = this.redactor.redact(url);
    const contextRequestId = this.context.getRequestId();
    const operationId = this.context.getOperationId();

    const ctx: FetchTelemetryContext = {
      requestId: randomUUID(),
      startTime: performance.now(),
      url: safeUrl,
      method: method.toUpperCase(),
    };
    if (contextRequestId) ctx.contextRequestId = contextRequestId;
    if (operationId) ctx.operationId = operationId;

    const fields = this.contextFields(ctx);
    const event: FetchStartEvent = {
      v: 1,
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...fields,
    };
    if (fetchChannels.hasSubscribers) {
      try {
        fetchChannels.start.publish(event);
      } catch {
        // Best-effort telemetry; never crash request path.
      }
    }

    this.logger.debug('HTTP Request', {
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...fields,
    });

    return ctx;
  }

  recordResponse(
    context: FetchTelemetryContext,
    response: Response,
    contentSize?: number
  ): void {
    const duration = performance.now() - context.startTime;
    const durationLabel = `${Math.round(duration)}ms`;
    const fields = this.contextFields(context);

    const event: FetchEndEvent = {
      v: 1,
      requestId: context.requestId,
      status: response.status,
      duration,
      ...fields,
    };
    if (fetchChannels.hasSubscribers) {
      try {
        fetchChannels.end.publish(event);
      } catch {
        // Best-effort telemetry; never crash request path.
      }
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    const contentLengthHeader = response.headers.get('content-length');
    const size =
      contentLengthHeader ??
      (contentSize === undefined ? undefined : String(contentSize));

    this.logger.debug('HTTP Response', {
      requestId: context.requestId,
      status: response.status,
      url: context.url,
      duration: durationLabel,
      ...fields,
      ...(contentType ? { contentType } : {}),
      ...(size ? { size } : {}),
    });

    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      this.logger.warn('Slow HTTP request detected', {
        requestId: context.requestId,
        url: context.url,
        duration: durationLabel,
        ...fields,
      });
    }
  }

  recordError(
    context: FetchTelemetryContext,
    error: unknown,
    status?: number
  ): void {
    const duration = performance.now() - context.startTime;
    const err = toError(error);
    const code = isSystemError(err) ? err.code : undefined;
    const fields = this.contextFields(context);

    const event: FetchErrorEvent = {
      v: 1,
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      duration,
      ...(code !== undefined ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      ...fields,
    };
    if (fetchChannels.hasSubscribers) {
      try {
        fetchChannels.error.publish(event);
      } catch {
        // Best-effort telemetry; never crash request path.
      }
    }

    const logData: Record<string, unknown> = {
      requestId: context.requestId,
      url: context.url,
      status,
      code,
      error: err.message,
      ...fields,
    };

    if (status === 429) {
      this.logger.warn('HTTP Request Error', logData);
      return;
    }

    this.logger.error('HTTP Request Error', logData);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ORCHESTRATION & EXPORTS
// ═══════════════════════════════════════════════════════════════════

interface FetchOptions {
  signal?: AbortSignal;
}
const defaultLogger: Logger = {
  debug: logDebug,
  warn: logWarn,
  error: logError,
};
const defaultContext = {
  getRequestId,
  getOperationId,
};
const defaultRedactor = {
  redact: redactUrl,
};
const defaultFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => globalThis.fetch(input, init);
type FetcherConfig = typeof config.fetcher;
interface FetchBufferResult {
  buffer: Uint8Array;
  encoding: string;
  truncated: boolean;
  finalUrl: string;
}
type FetchReadMode = 'text' | 'buffer';
type FetchReadResult = string | FetchBufferResult;
class HttpFetcher {
  constructor(
    private readonly fetcherConfig: FetcherConfig,
    private readonly redirectFollower: RedirectFollower,
    private readonly reader: ResponseTextReader,
    private readonly telemetry: FetchTelemetry
  ) {}

  async fetchNormalizedUrl(
    normalizedUrl: string,
    options?: FetchOptions
  ): Promise<string> {
    return this.fetchNormalized(normalizedUrl, 'text', options);
  }

  async fetchNormalizedUrlBuffer(
    normalizedUrl: string,
    options?: FetchOptions
  ): Promise<FetchBufferResult> {
    return this.fetchNormalized(normalizedUrl, 'buffer', options);
  }

  private async fetchNormalized(
    normalizedUrl: string,
    mode: 'text',
    options?: FetchOptions
  ): Promise<string>;
  private async fetchNormalized(
    normalizedUrl: string,
    mode: 'buffer',
    options?: FetchOptions
  ): Promise<FetchBufferResult>;
  private async fetchNormalized(
    normalizedUrl: string,
    mode: FetchReadMode,
    options?: FetchOptions
  ): Promise<FetchReadResult> {
    const timeoutMs = this.fetcherConfig.timeout;
    const headers = DEFAULT_HEADERS;
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const init = buildRequestInit(headers, signal);

    const ctx = this.telemetry.start(normalizedUrl, 'GET');

    let agent: Agent | undefined;
    try {
      const {
        response,
        url: finalUrl,
        agent: returnedAgent,
      } = await this.redirectFollower.fetchWithRedirects(
        normalizedUrl,
        init,
        this.fetcherConfig.maxRedirects
      );
      agent = returnedAgent;

      ctx.url = this.telemetry.redact(finalUrl);
      return await this.readPayload(
        response,
        finalUrl,
        ctx,
        mode,
        init.signal ?? undefined
      );
    } catch (error: unknown) {
      const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
      ctx.url = this.telemetry.redact(mapped.url);
      this.telemetry.recordError(ctx, mapped, mapped.statusCode);
      throw mapped;
    } finally {
      await agent?.close();
    }
  }

  private async readPayload(
    response: Response,
    finalUrl: string,
    ctx: FetchTelemetryContext,
    mode: FetchReadMode,
    signal?: AbortSignal
  ): Promise<FetchReadResult> {
    try {
      const payload = await readAndRecordDecodedResponse({
        response,
        finalUrl,
        ctx,
        telemetry: this.telemetry,
        reader: this.reader,
        maxBytes: this.fetcherConfig.maxContentLength,
        mode,
        ...(signal ? { signal } : {}),
      });

      if (payload.kind === 'text') return payload.text;

      return {
        buffer: payload.buffer,
        encoding: payload.encoding,
        truncated: payload.truncated,
        finalUrl,
      };
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
}
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  // Accept-Encoding and Connection are forbidden Fetch API headers.
  // The undici-based globalThis.fetch manages content negotiation and
  // decompression transparently per the Fetch spec.
};
function buildRequestSignal(
  timeoutMs: number,
  external?: AbortSignal
): AbortSignal | undefined {
  return composeAbortSignal(external, timeoutMs);
}
function buildRequestInit(
  headers: HeadersInit,
  signal?: AbortSignal
): RequestInit {
  return {
    method: 'GET',
    headers,
    ...(signal ? { signal } : {}),
  };
}
interface HttpModuleSingletons {
  readonly ipBlocker: IpBlocker;
  readonly urlNormalizer: UrlNormalizer;
  readonly rawUrlTransformer: RawUrlTransformer;
  readonly telemetry: FetchTelemetry;
  readonly secureRedirectFollower: RedirectFollower;
  readonly responseReader: ResponseTextReader;
  readonly httpFetcher: HttpFetcher;
}
function createHttpModule(): HttpModuleSingletons {
  const ipBlocker = new IpBlocker(config.security);
  const urlNormalizer = new UrlNormalizer(
    config.constants,
    config.security,
    ipBlocker,
    BLOCKED_HOST_SUFFIXES
  );
  const rawUrlTransformer = new RawUrlTransformer(defaultLogger);
  const dnsResolver = new SafeDnsResolver(
    ipBlocker,
    config.security,
    BLOCKED_HOST_SUFFIXES
  );
  const tel = new FetchTelemetry(
    defaultLogger,
    defaultContext,
    defaultRedactor
  );
  const normalizeRedirectUrl = (url: string): string =>
    urlNormalizer.validateAndNormalize(url);
  const dnsPreflight = createDnsPreflight(dnsResolver);
  const secureRedirectFollower = new RedirectFollower(
    defaultFetch,
    normalizeRedirectUrl,
    dnsPreflight
  );
  const responseReader = new ResponseTextReader();
  const httpFetcher = new HttpFetcher(
    config.fetcher,
    secureRedirectFollower,
    responseReader,
    tel
  );
  return {
    ipBlocker,
    urlNormalizer,
    rawUrlTransformer,
    telemetry: tel,
    secureRedirectFollower,
    responseReader,
    httpFetcher,
  } as const;
}
const {
  ipBlocker,
  urlNormalizer,
  rawUrlTransformer,
  telemetry,
  secureRedirectFollower,
  responseReader,
  httpFetcher,
} = createHttpModule();
export function isBlockedIp(ip: string): boolean {
  return ipBlocker.isBlockedIp(ip);
}
export function normalizeUrl(urlString: string): {
  normalizedUrl: string;
  hostname: string;
} {
  return urlNormalizer.normalize(urlString);
}
export function validateAndNormalizeUrl(urlString: string): string {
  return urlNormalizer.validateAndNormalize(urlString);
}
export function transformToRawUrl(url: string): TransformResult {
  return rawUrlTransformer.transformToRawUrl(url);
}
export function isRawTextContentUrl(url: string): boolean {
  return rawUrlTransformer.isRawTextContentUrl(url);
}
export function startFetchTelemetry(
  url: string,
  method: string
): FetchTelemetryContext {
  return telemetry.start(url, method);
}
export function recordFetchResponse(
  context: FetchTelemetryContext,
  response: Response,
  contentSize?: number
): void {
  telemetry.recordResponse(context, response, contentSize);
}
export function recordFetchError(
  context: FetchTelemetryContext,
  error: unknown,
  status?: number
): void {
  telemetry.recordError(context, error, status);
}
export async function fetchWithRedirects(
  url: string,
  init: RequestInit,
  maxRedirects: number
): Promise<{ response: Response; url: string; agent?: Agent }> {
  return secureRedirectFollower.fetchWithRedirects(url, init, maxRedirects);
}
export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
  encoding?: string
): Promise<{ text: string; size: number }> {
  const decodedResponse = await decodeResponseIfNeeded(response, url, signal);
  const { text, size } = await responseReader.read(decodedResponse, {
    url,
    maxBytes,
    signal,
    encoding,
  });
  return { text, size };
}
export async function fetchNormalizedUrl(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<string> {
  return httpFetcher.fetchNormalizedUrl(normalizedUrl, options);
}
export async function fetchNormalizedUrlBuffer(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<{
  buffer: Uint8Array;
  encoding: string;
  truncated: boolean;
  finalUrl: string;
}> {
  return httpFetcher.fetchNormalizedUrlBuffer(normalizedUrl, options);
}
