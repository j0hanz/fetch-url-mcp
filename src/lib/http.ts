import { isUtf8 } from 'node:buffer';
import { hash, randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { type ServerResponse } from 'node:http';
import { posix as pathPosix } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { finished, pipeline } from 'node:stream/promises';
import { type ReadableStream as NodeReadableStream } from 'node:stream/web';
import tls from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { Agent, type Dispatcher } from 'undici';
import { z } from 'zod';

import { parseCachedPayload, resolveCachedPayloadContent } from '../schemas.js';
import {
  get as cacheGet,
  config,
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  redactUrl,
} from './core.js';
import { isIP } from './net-utils.js';
import {
  BLOCKED_HOST_SUFFIXES,
  createDnsPreflight,
  IpBlocker,
  type Logger,
  RawUrlTransformer,
  SafeDnsResolver,
  type TransformResult,
  UrlNormalizer,
  VALIDATION_ERROR_CODE,
} from './url.js';
import {
  composeAbortSignal,
  createErrorWithCode,
  FetchError,
  isAbortError,
  isError,
  isObject,
  isSystemError,
  toError,
} from './utils.js';
import { formatZodError } from './zod.js';

// ═══════════════════════════════════════════════════════════════════
// FILENAME GENERATION & DOWNLOAD
// ═══════════════════════════════════════════════════════════════════

const FILENAME_RULES = {
  MAX_LEN: 200,
  UNSAFE_CHARS: /[<>:"/\\|?*\p{C}]/gu,
  WHITESPACE: /\s+/g,
  EXTENSIONS: /\.(html?|php|aspx?|jsp)$/i,
} as const;
function sanitizeString(input: string): string {
  return input
    .toLowerCase()
    .replace(FILENAME_RULES.UNSAFE_CHARS, '')
    .replace(FILENAME_RULES.WHITESPACE, '-')
    .replace(/-+/g, '-')
    .replace(/(?:^-|-$)/g, '');
}
function resolveUrlFilenameCandidate(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const basename = pathPosix.basename(parsed.pathname);
  if (!basename || basename === 'index') return null;

  const cleaned = basename.replace(FILENAME_RULES.EXTENSIONS, '');
  const sanitized = sanitizeString(cleaned);

  if (sanitized === 'index') return null;
  return sanitized || null;
}
function truncateFilenameBase(name: string, extension: string): string {
  const maxBase = FILENAME_RULES.MAX_LEN - extension.length;
  return name.length > maxBase ? name.substring(0, maxBase) : name;
}
function resolveTitleFilenameCandidate(title?: string): string | null {
  if (!title) return null;
  return sanitizeString(title) || null;
}
function resolveFilenameBase(
  url: string,
  title?: string,
  hashFallback?: string
): string {
  try {
    const fromUrl = resolveUrlFilenameCandidate(url);
    if (fromUrl) return fromUrl;
  } catch {
    // Ignore URL parsing errors and continue fallbacks.
  }

  const fromTitle = resolveTitleFilenameCandidate(title);
  if (fromTitle) return fromTitle;

  if (hashFallback) return hashFallback.substring(0, 16);
  return `download-${hash('sha256', url, 'hex').substring(0, 16)}`;
}
export function generateSafeFilename(
  url: string,
  title?: string,
  hashFallback?: string,
  extension = '.md'
): string {
  const name = resolveFilenameBase(url, title, hashFallback);

  return `${truncateFilenameBase(name, extension)}${extension}`;
}
const DownloadParamsSchema = z.strictObject({
  namespace: z.literal('markdown'),
  hash: z
    .string()
    .regex(/^[a-f0-9.]+$/i)
    .min(8)
    .max(64),
});
function writeJsonError(
  res: ServerResponse,
  status: number,
  message: string,
  code: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message, code }));
}
export function handleDownload(
  res: ServerResponse,
  namespace: string,
  hash: string
): void {
  const parsed = DownloadParamsSchema.safeParse({ namespace, hash });
  if (!parsed.success) {
    writeJsonError(
      res,
      400,
      `Invalid download parameters: ${formatZodError(parsed.error)}`,
      'BAD_REQUEST'
    );
    return;
  }

  const cacheKey = `${parsed.data.namespace}:${parsed.data.hash}`;
  const entry = cacheGet(cacheKey, { force: true });

  if (!entry) {
    writeJsonError(res, 404, 'Not found or expired', 'NOT_FOUND');
    return;
  }

  const payload = parseCachedPayload(entry.content);
  const content = payload ? resolveCachedPayloadContent(payload) : null;

  if (!content) {
    writeJsonError(res, 404, 'Content missing', 'NOT_FOUND');
    return;
  }

  const fileName = generateSafeFilename(
    entry.url,
    payload?.title,
    parsed.data.hash
  );

  // Safe header generation — RFC 5987 encoding for non-ASCII filenames
  const encoded = encodeURIComponent(fileName).replace(/'/g, '%27');

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(content);
}

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
  const scanSize = Math.min(buffer.length, 8_192);
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

const BINARY_SIGNATURES = [
  [0x25, 0x50, 0x44, 0x46],
  [0x89, 0x50, 0x4e, 0x47],
  [0x47, 0x49, 0x46, 0x38],
  [0xff, 0xd8, 0xff],
  [0x52, 0x49, 0x46, 0x46],
  [0x42, 0x4d],
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
  [0x00, 0x00, 0x01, 0x00],
  [0x50, 0x4b, 0x03, 0x04],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0x52, 0x61, 0x72, 0x21],
  [0x37, 0x7a, 0xbc, 0xaf],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0x00, 0x61, 0x73, 0x6d],
  [0x1a, 0x45, 0xdf, 0xa3],
  [0x66, 0x74, 0x79, 0x70],
  [0x46, 0x4c, 0x56],
  [0x49, 0x44, 0x33],
  [0xff, 0xfb],
  [0xff, 0xfa],
  [0x4f, 0x67, 0x67, 0x53],
  [0x66, 0x4c, 0x61, 0x43],
  [0x4d, 0x54, 0x68, 0x64],
  [0x77, 0x4f, 0x46, 0x46],
  [0x00, 0x01, 0x00, 0x00],
  [0x4f, 0x54, 0x54, 0x4f],
  [0x53, 0x51, 0x4c, 0x69],
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

  const sample = buffer.length > 8192 ? buffer.subarray(0, 8192) : buffer;
  if (isUtf8(sample)) return false;

  return hasNullByte(buffer, 8192);
}
function createBinaryContentError(url: string): FetchError {
  return new FetchError(
    'Detailed content type check failed: binary content detected',
    url,
    500,
    { reason: 'binary_content_detected' }
  );
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
    case 'canceled':
      return new FetchError('Request was canceled', url, 499, {
        reason: 'aborted',
      });
    case 'aborted':
      return new FetchError(
        'Request was aborted during response read',
        url,
        499,
        { reason: 'aborted' }
      );
    case 'timeout':
      return new FetchError(
        `Request timeout after ${input.timeout}ms`,
        url,
        504,
        { timeout: input.timeout }
      );
    case 'rate-limited':
      return new FetchError('Too many requests', url, 429, {
        retryAfter: parseRetryAfter(input.retryAfter),
      });
    case 'http':
      return new FetchError(
        `HTTP ${input.status}: ${input.statusText}`,
        url,
        input.status
      );
    case 'too-many-redirects':
      return new FetchError('Too many redirects', url);
    case 'missing-redirect-location':
      return new FetchError('Redirect response missing Location header', url);
    case 'network':
      return new FetchError(
        `Network error: Could not reach ${url}`,
        url,
        undefined,
        { message: input.message }
      );
    case 'unknown':
      return new FetchError(input.message ?? 'Unexpected error', url);
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

  const { requestUrl } = error as Record<string, unknown>;
  return typeof requestUrl === 'string' ? requestUrl : fallback;
}
function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error) || isTimeoutError(error)) {
    return isTimeoutError(error)
      ? createFetchError({ kind: 'timeout', timeout: timeoutMs }, url)
      : createFetchError({ kind: 'canceled' }, url);
  }

  if (!isError(error))
    return createFetchError(
      { kind: 'unknown', message: 'Unexpected error' },
      url
    );

  if (!isSystemError(error)) {
    const err = error as { message: string; cause?: unknown };
    const causeStr =
      err.cause instanceof Error ? err.cause.message : String(err.cause);
    return createFetchError(
      { kind: 'network', message: `${err.message}. Cause: ${causeStr}` },
      url
    );
  }

  const { code } = error;

  if (code === 'ETIMEOUT') {
    return new FetchError(error.message, url, 504, { code });
  }

  if (
    code === VALIDATION_ERROR_CODE ||
    code === 'EBADREDIRECT' ||
    code === 'EBLOCKED' ||
    code === 'ENODATA' ||
    code === 'EINVAL'
  ) {
    return new FetchError(error.message, url, 400, { code });
  }

  return createFetchError({ kind: 'network', message: error.message }, url);
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
  return new Agent({
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
      const parsedNextUrl = new URL(nextUrl);
      if (
        parsedNextUrl.protocol !== 'http:' &&
        parsedNextUrl.protocol !== 'https:'
      ) {
        throw createErrorWithCode(
          `Unsupported redirect protocol: ${parsedNextUrl.protocol}`,
          'EUNSUPPORTEDPROTOCOL'
        );
      }

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
      throw createErrorWithCode('Invalid redirect target', 'EBADREDIRECT');
    }
    if (resolved.username || resolved.password) {
      throw createErrorWithCode(
        'Redirect target includes credentials',
        'EBADREDIRECT'
      );
    }

    return this.normalizeUrl(resolved.href);
  }

  private annotateRedirectError(error: unknown, url: string): void {
    if (!isObject(error)) return;
    (error as Record<string, unknown>)['requestUrl'] = url;
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
    logDebug('No Content-Type header; relying on binary-content detection', {
      url: redactUrl(url),
    });
    return;
  }

  if (!isTextLikeMediaType(mediaType)) {
    throw new FetchError(`Unsupported content type: ${mediaType}`, url);
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
  return new FetchError(
    `Unsupported Content-Encoding: ${encodingHeader}`,
    url,
    415,
    {
      reason: 'unsupported_content_encoding',
      encoding: encodingHeader,
    }
  );
}
function createDecompressor(
  encoding: ContentEncoding
):
  | ReturnType<typeof createGunzip>
  | ReturnType<typeof createInflate>
  | ReturnType<typeof createBrotliDecompress> {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
  }
}
function createPumpedStream(
  initialChunk: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  return new ReadableStream({
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
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: pipe.headers,
      });
    }

    const body = createPumpedStream(first.value, pipe.decodedReader);

    if (signal) {
      void finished(pipe.decodedNodeStream, { cleanup: true })
        .catch(() => {})
        .finally(() => {
          clearAbortListener();
        });
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: pipe.headers,
    });
  } catch (error: unknown) {
    clearAbortListener();
    pipe.cleanup();
    void pipe.decodedReader.cancel(error).catch(() => undefined);

    throw new FetchError(
      `Content-Encoding decode failed for ${redactUrl(url)}: ${isError(error) ? error.message : String(error)}`,
      url
    );
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

function concatUint8Arrays(
  chunks: Uint8Array[],
  totalLength: number
): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class BoundedBufferTransform extends Transform {
  total = 0;
  readonly chunks: Uint8Array[] = [];
  effectiveEncoding: string;
  private encodingResolved = false;
  private firstChunk = true;

  constructor(
    private readonly byteLimit: number,
    private readonly captureChunks: boolean,
    private readonly url: string,
    private readonly declaredEncoding: string | undefined
  ) {
    super();
    this.effectiveEncoding = declaredEncoding ?? 'utf-8';
  }

  override _transform(
    chunk: unknown,
    _encoding: string,
    callback: (error?: Error | null, data?: Uint8Array) => void
  ): void {
    try {
      const buf: Uint8Array =
        chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk as ArrayBuffer);

      this.resolveChunkEncoding(buf);

      const binaryError = this.detectBinaryContent(buf);
      if (binaryError) {
        callback(binaryError);
        return;
      }

      this.enforceByteLimit(buf, callback);
    } catch (error: unknown) {
      callback(toError(error));
    }
  }

  private resolveChunkEncoding(buf: Uint8Array): void {
    if (this.encodingResolved) return;
    this.encodingResolved = true;
    this.effectiveEncoding = resolveEncoding(this.declaredEncoding, buf);
  }

  private detectBinaryContent(buf: Uint8Array): FetchError | null {
    const isFirst = this.firstChunk;
    this.firstChunk = false;
    if (
      (isFirst && hasBinarySignature(buf)) ||
      (!isUnicodeWideEncoding(this.effectiveEncoding) && hasNullByte(buf, 1000))
    ) {
      return createBinaryContentError(this.url);
    }
    return null;
  }

  private enforceByteLimit(
    buf: Uint8Array,
    callback: (error?: Error | null, data?: Uint8Array) => void
  ): void {
    const newTotal = this.total + buf.length;
    if (newTotal > this.byteLimit) {
      const remaining = this.byteLimit - this.total;
      if (remaining > 0) {
        const slice = buf.subarray(0, remaining);
        this.total += remaining;
        if (this.captureChunks) this.chunks.push(slice);
        this.push(slice);
      }
      callback(new MaxBytesError());
      return;
    }

    this.total = newTotal;
    if (this.captureChunks) this.chunks.push(buf);
    callback(null, buf);
  }
}
function assertNonBinaryContent(
  buffer: Uint8Array,
  encoding: string,
  url: string
): void {
  if (isBinaryContent(buffer, encoding)) {
    throw createBinaryContentError(url);
  }
}
class ResponseTextReader {
  async read(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{ text: string; size: number; truncated: boolean }> {
    const {
      buffer,
      encoding: effectiveEncoding,
      truncated,
    } = await this.readBuffer(response, url, maxBytes, signal, encoding);

    const text = decodeBuffer(buffer, effectiveEncoding);
    return { text, size: buffer.byteLength, truncated };
  }

  async readBuffer(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    if (signal?.aborted) {
      cancelResponseBody(response);
      throw createFetchError({ kind: 'aborted' }, url);
    }

    if (!response.body) {
      return this.readNonStreamBuffer(
        response,
        url,
        maxBytes,
        signal,
        encoding
      );
    }

    return this.readStreamToBuffer(
      response.body,
      url,
      maxBytes,
      signal,
      encoding
    );
  }

  private async readNonStreamBuffer(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    if (signal?.aborted) throw createFetchError({ kind: 'canceled' }, url);

    const limit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;

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
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    const byteLimit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;
    const captureChunks = byteLimit !== Number.POSITIVE_INFINITY;

    const source = Readable.fromWeb(
      toNodeReadableStream(stream, url, 'response:read-stream-buffer')
    );

    const guard = new BoundedBufferTransform(
      byteLimit,
      captureChunks,
      url,
      encoding
    );

    const guarded = source.pipe(guard);
    const abortHandler = (): void => {
      source.destroy();
      guard.destroy();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const buffer = await consumeBuffer(guarded);
      return {
        buffer,
        encoding: guard.effectiveEncoding,
        size: guard.total,
        truncated: false,
      };
    } catch (error: unknown) {
      if (signal?.aborted) throw createFetchError({ kind: 'aborted' }, url);
      if (error instanceof FetchError) throw error;
      if (error instanceof MaxBytesError) {
        source.destroy();
        guard.destroy();
        return {
          buffer: concatUint8Arrays(guard.chunks, guard.total),
          encoding: guard.effectiveEncoding,
          size: guard.total,
          truncated: true,
        };
      }
      throw error;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
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
    const { text, size, truncated } = await reader.read(
      response,
      finalUrl,
      maxBytes,
      signal,
      declaredEncoding
    );
    telemetry.recordResponse(ctx, response, size);
    return { kind: 'text', text, size, truncated };
  }

  const { buffer, encoding, size, truncated } = await reader.readBuffer(
    response,
    finalUrl,
    maxBytes,
    signal,
    declaredEncoding
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
  throw new FetchError('Invalid response stream', url, 500, {
    reason: 'invalid_stream',
    stage,
  });
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
type FetchChannelEvent =
  | {
      v: 1;
      type: 'start';
      requestId: string;
      method: string;
      url: string;
      contextRequestId?: string;
      operationId?: string;
    }
  | {
      v: 1;
      type: 'end';
      requestId: string;
      status: number;
      duration: number;
      contextRequestId?: string;
      operationId?: string;
    }
  | {
      v: 1;
      type: 'error';
      requestId: string;
      url: string;
      error: string;
      code?: string;
      status?: number;
      duration: number;
      contextRequestId?: string;
      operationId?: string;
    };
const fetchChannel = diagnosticsChannel.channel('fetch-url-mcp.fetch');
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
    this.publish({
      v: 1,
      type: 'start',
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...fields,
    });

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

    this.publish({
      v: 1,
      type: 'end',
      requestId: context.requestId,
      status: response.status,
      duration,
      ...fields,
    });

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

    this.publish({
      v: 1,
      type: 'error',
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      duration,
      ...(code !== undefined ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      ...fields,
    });

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

  private publish(event: FetchChannelEvent): void {
    if (!fetchChannel.hasSubscribers) return;

    try {
      fetchChannel.publish(event);
    } catch {
      // Best-effort telemetry; never crash request path.
    }
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
  const { text, size } = await responseReader.read(
    decodedResponse,
    url,
    maxBytes,
    signal,
    encoding
  );
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
