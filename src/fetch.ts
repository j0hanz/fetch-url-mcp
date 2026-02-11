import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable, Transform } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { finished, pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { config } from './config.js';
import { createErrorWithCode, FetchError, isSystemError } from './errors.js';
import {
  createDefaultBlockList,
  normalizeIpForBlockList,
} from './ip-blocklist.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  redactUrl,
} from './observability.js';
import { isError, isObject } from './type-guards.js';

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface TransformResult {
  readonly url: string;
  readonly transformed: boolean;
  readonly platform?: string;
}

interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

interface RequestContextAccessor {
  getRequestId(): string | undefined;
  getOperationId(): string | undefined;
}

interface UrlRedactor {
  redact(url: string): string;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const defaultLogger: Logger = {
  debug: logDebug,
  warn: logWarn,
  error: logError,
};

const defaultContext: RequestContextAccessor = {
  getRequestId,
  getOperationId,
};

const defaultRedactor: UrlRedactor = {
  redact: redactUrl,
};

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

type SecurityConfig = typeof config.security;

class IpBlocker {
  private readonly blockList = createDefaultBlockList();

  constructor(private readonly security: SecurityConfig) {}

  isBlockedIp(candidate: string): boolean {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) return false;
    if (this.security.blockedHosts.has(normalized)) return true;

    const normalizedIp = normalizeIpForBlockList(normalized);
    if (!normalizedIp) return false;
    return this.blockList.check(normalizedIp.ip, normalizedIp.family);
  }
}

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

function createValidationError(message: string): Error {
  return createErrorWithCode(message, VALIDATION_ERROR_CODE);
}

const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];

type ConstantsConfig = typeof config.constants;

class UrlNormalizer {
  constructor(
    private readonly constants: ConstantsConfig,
    private readonly security: SecurityConfig,
    private readonly ipBlocker: IpBlocker,
    private readonly blockedHostSuffixes: readonly string[]
  ) {}

  normalize(urlString: string): { normalizedUrl: string; hostname: string } {
    const trimmedUrl = this.requireTrimmedUrl(urlString);
    if (trimmedUrl.length > this.constants.maxUrlLength) {
      throw createValidationError(
        `URL exceeds maximum length of ${this.constants.maxUrlLength} characters`
      );
    }
    let url: URL;
    try {
      url = new URL(trimmedUrl);
    } catch {
      throw createValidationError('Invalid URL format');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw createValidationError(
        `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`
      );
    }
    if (url.username || url.password) {
      throw createValidationError(
        'URLs with embedded credentials are not allowed'
      );
    }

    const hostname = this.normalizeHostname(url);
    this.assertHostnameAllowed(hostname);

    url.hostname = hostname;
    return { normalizedUrl: url.href, hostname };
  }

  validateAndNormalize(urlString: string): string {
    return this.normalize(urlString).normalizedUrl;
  }

  private requireTrimmedUrl(urlString: string): string {
    if (!urlString || typeof urlString !== 'string') {
      throw createValidationError('URL is required');
    }

    const trimmed = urlString.trim();
    if (!trimmed) throw createValidationError('URL cannot be empty');
    return trimmed;
  }

  private normalizeHostname(url: URL): string {
    let hostname = url.hostname.toLowerCase();
    while (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

    if (!hostname) {
      throw createValidationError('URL must have a valid hostname');
    }

    return hostname;
  }

  private assertHostnameAllowed(hostname: string): void {
    this.assertNotBlockedHost(hostname);
    this.assertNotBlockedIp(hostname);
    this.assertNotBlockedHostnameSuffix(hostname);
  }

  private assertNotBlockedHost(hostname: string): void {
    if (!this.security.blockedHosts.has(hostname)) return;
    throw createValidationError(
      `Blocked host: ${hostname}. Internal hosts are not allowed`
    );
  }

  private assertNotBlockedIp(hostname: string): void {
    if (!this.ipBlocker.isBlockedIp(hostname)) return;
    throw createValidationError(
      `Blocked IP range: ${hostname}. Private IPs are not allowed`
    );
  }

  private assertNotBlockedHostnameSuffix(hostname: string): void {
    const blocked = this.blockedHostSuffixes.some((suffix) =>
      hostname.endsWith(suffix)
    );
    if (!blocked) return;

    throw createValidationError(
      `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`
    );
  }
}

type UrlPatternGroups = Record<string, string | undefined>;

function getPatternGroup(groups: UrlPatternGroups, key: string): string | null {
  const value = groups[key];
  if (value === undefined) return null;
  if (value === '') return null;
  return value;
}

const GITHUB_BLOB_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: '{:sub.}?github.com',
  pathname: '/:owner/:repo/blob/:branch/:path+',
});

const GITHUB_GIST_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: 'gist.github.com',
  pathname: '/:user/:gistId',
});

const GITHUB_GIST_RAW_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: 'gist.github.com',
  pathname: '/:user/:gistId/raw/:filePath+',
});

const GITLAB_BLOB_PATTERNS: readonly URLPattern[] = [
  new URLPattern({
    protocol: 'http{s}?',
    hostname: 'gitlab.com',
    pathname: '/:base+/-/blob/:branch/:path+',
  }),
  new URLPattern({
    protocol: 'http{s}?',
    hostname: '*:sub.gitlab.com',
    pathname: '/:base+/-/blob/:branch/:path+',
  }),
];

const BITBUCKET_SRC_PATTERN = new URLPattern({
  protocol: 'http{s}?',
  hostname: '{:sub.}?bitbucket.org',
  pathname: '/:owner/:repo/src/:branch/:path+',
});

const BITBUCKET_RAW_RE = /bitbucket\.org\/[^/]+\/[^/]+\/raw\//;

const RAW_TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  '.rst',
  '.adoc',
  '.org',
]);

class RawUrlTransformer {
  constructor(private readonly logger: Logger) {}

  transformToRawUrl(url: string): TransformResult {
    if (!url) return { url, transformed: false };
    if (this.isRawUrl(url)) return { url, transformed: false };
    let base: string;
    let hash: string;
    let parsed: URL | undefined;

    try {
      parsed = new URL(url);
      base = parsed.origin + parsed.pathname;
      ({ hash } = parsed);
    } catch {
      ({ base, hash } = this.splitParams(url));
    }

    const match = this.tryTransformWithUrl(base, hash, parsed);
    if (!match) return { url, transformed: false };

    this.logger.debug('URL transformed to raw content URL', {
      platform: match.platform,
      original: url.substring(0, 100),
      transformed: match.url.substring(0, 100),
    });

    return { url: match.url, transformed: true, platform: match.platform };
  }

  isRawTextContentUrl(urlString: string): boolean {
    if (!urlString) return false;
    if (this.isRawUrl(urlString)) return true;

    try {
      const url = new URL(urlString);
      const pathname = url.pathname.toLowerCase();
      const lastDot = pathname.lastIndexOf('.');
      if (lastDot === -1) return false;

      return RAW_TEXT_EXTENSIONS.has(pathname.slice(lastDot));
    } catch {
      const { base } = this.splitParams(urlString);
      const lowerBase = base.toLowerCase();
      const lastDot = lowerBase.lastIndexOf('.');
      if (lastDot === -1) return false;

      return RAW_TEXT_EXTENSIONS.has(lowerBase.slice(lastDot));
    }
  }

  private isRawUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return (
      lower.includes('raw.githubusercontent.com') ||
      lower.includes('gist.githubusercontent.com') ||
      lower.includes('/-/raw/') ||
      BITBUCKET_RAW_RE.test(lower)
    );
  }

  private splitParams(urlString: string): { base: string; hash: string } {
    try {
      const url = new URL(urlString);
      const base = url.origin + url.pathname;
      return { base, hash: url.hash };
    } catch {
      const hashIndex = urlString.indexOf('#');
      const queryIndex = urlString.indexOf('?');
      const endIndex = Math.min(
        queryIndex === -1 ? urlString.length : queryIndex,
        hashIndex === -1 ? urlString.length : hashIndex
      );

      const hash = hashIndex !== -1 ? urlString.slice(hashIndex) : '';
      return { base: urlString.slice(0, endIndex), hash };
    }
  }

  private tryTransformWithUrl(
    base: string,
    hash: string,
    preParsed?: URL
  ): { url: string; platform: string } | null {
    let parsed: URL | null = null;
    if (preParsed?.href.startsWith(base)) {
      parsed = preParsed;
    } else {
      try {
        parsed = new URL(base);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) return null;

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;

    const gist = this.transformGithubGist(base, hash);
    if (gist) return gist;

    const github = this.transformGithubBlob(base);
    if (github) return github;

    const gitlab = this.transformGitLab(base, parsed.origin);
    if (gitlab) return gitlab;

    const bitbucket = this.transformBitbucket(base, parsed.origin);
    if (bitbucket) return bitbucket;

    return null;
  }

  private transformGithubBlob(
    url: string
  ): { url: string; platform: string } | null {
    const match = GITHUB_BLOB_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const owner = getPatternGroup(groups, 'owner');
    const repo = getPatternGroup(groups, 'repo');
    const branch = getPatternGroup(groups, 'branch');
    const path = getPatternGroup(groups, 'path');
    if (!owner || !repo || !branch || !path) return null;

    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
      platform: 'github',
    };
  }

  private transformGithubGist(
    url: string,
    hash: string
  ): { url: string; platform: string } | null {
    const rawMatch = GITHUB_GIST_RAW_PATTERN.exec(url);
    if (rawMatch) {
      const groups = rawMatch.pathname.groups as UrlPatternGroups;
      const user = getPatternGroup(groups, 'user');
      const gistId = getPatternGroup(groups, 'gistId');
      const filePath = getPatternGroup(groups, 'filePath');
      if (!user || !gistId) return null;

      const resolvedFilePath = filePath ? `/${filePath}` : '';

      return {
        url: `https://gist.githubusercontent.com/${user}/${gistId}/raw${resolvedFilePath}`,
        platform: 'github-gist',
      };
    }

    const match = GITHUB_GIST_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const user = getPatternGroup(groups, 'user');
    const gistId = getPatternGroup(groups, 'gistId');
    if (!user || !gistId) return null;

    let filePath = '';
    if (hash.startsWith('#file-')) {
      const filename = hash.slice('#file-'.length).replace(/-/g, '.');
      if (filename) filePath = `/${filename}`;
    }

    return {
      url: `https://gist.githubusercontent.com/${user}/${gistId}/raw${filePath}`,
      platform: 'github-gist',
    };
  }

  private transformGitLab(
    url: string,
    origin: string
  ): { url: string; platform: string } | null {
    for (const pattern of GITLAB_BLOB_PATTERNS) {
      const match = pattern.exec(url);
      if (!match) continue;

      const groups = match.pathname.groups as UrlPatternGroups;
      const base = getPatternGroup(groups, 'base');
      const branch = getPatternGroup(groups, 'branch');
      const path = getPatternGroup(groups, 'path');
      if (!base || !branch || !path) return null;

      return {
        url: `${origin}/${base}/-/raw/${branch}/${path}`,
        platform: 'gitlab',
      };
    }

    return null;
  }

  private transformBitbucket(
    url: string,
    origin: string
  ): { url: string; platform: string } | null {
    const match = BITBUCKET_SRC_PATTERN.exec(url);
    if (!match) return null;

    const groups = match.pathname.groups as UrlPatternGroups;
    const owner = getPatternGroup(groups, 'owner');
    const repo = getPatternGroup(groups, 'repo');
    const branch = getPatternGroup(groups, 'branch');
    const path = getPatternGroup(groups, 'path');
    if (!owner || !repo || !branch || !path) return null;

    return {
      url: `${origin}/${owner}/${repo}/raw/${branch}/${path}`,
      platform: 'bitbucket',
    };
  }
}

const DNS_LOOKUP_TIMEOUT_MS = 5000;
const CNAME_LOOKUP_MAX_DEPTH = 5;

function normalizeDnsName(value: string): string {
  let normalized = value.trim().toLowerCase();
  while (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  return normalized;
}

interface AbortRace {
  abortPromise: Promise<never>;
  cleanup: () => void;
}

function createSignalAbortRace(
  signal: AbortSignal,
  isAbort: () => boolean,
  onTimeout: () => Error,
  onAbort: () => Error
): AbortRace {
  let abortListener: (() => void) | null = null;

  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      reject(isAbort() ? onAbort() : onTimeout());
    };
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });

  const cleanup = (): void => {
    if (!abortListener) return;
    try {
      signal.removeEventListener('abort', abortListener);
    } catch {
      // Ignore listener cleanup failures; they are non-fatal by design.
    }
    abortListener = null;
  };

  return { abortPromise, cleanup };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  signal?: AbortSignal,
  onAbort?: () => Error
): Promise<T> {
  const timeoutSignal =
    timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const raceSignal =
    signal && timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : (signal ?? timeoutSignal);
  if (!raceSignal) return promise;

  const abortRace = createSignalAbortRace(
    raceSignal,
    () => signal?.aborted === true,
    onTimeout,
    onAbort ?? (() => new Error('Request was canceled'))
  );

  try {
    return await Promise.race([promise, abortRace.abortPromise]);
  } finally {
    abortRace.cleanup();
  }
}

function createAbortSignalError(): Error {
  const err = new Error('Request was canceled');
  err.name = 'AbortError';
  return err;
}

class SafeDnsResolver {
  constructor(
    private readonly ipBlocker: IpBlocker,
    private readonly security: SecurityConfig,
    private readonly blockedHostSuffixes: readonly string[]
  ) {}

  async assertSafeHostname(
    hostname: string,
    signal?: AbortSignal
  ): Promise<void> {
    const normalizedHostname = normalizeDnsName(hostname);

    if (!normalizedHostname) {
      throw createErrorWithCode('Invalid hostname provided', 'EINVAL');
    }

    if (signal?.aborted) {
      throw createAbortSignalError();
    }

    if (isIP(normalizedHostname)) {
      if (this.ipBlocker.isBlockedIp(normalizedHostname)) {
        throw createErrorWithCode(
          `Blocked IP range: ${normalizedHostname}. Private IPs are not allowed`,
          'EBLOCKED'
        );
      }
      return;
    }

    await this.assertNoBlockedCname(normalizedHostname, signal);

    const resultPromise = dns.promises.lookup(normalizedHostname, {
      all: true,
      order: 'verbatim',
    });

    const addresses = await withTimeout(
      resultPromise,
      DNS_LOOKUP_TIMEOUT_MS,
      () =>
        createErrorWithCode(
          `DNS lookup timed out for ${normalizedHostname}`,
          'ETIMEOUT'
        ),
      signal,
      createAbortSignalError
    );

    if (addresses.length === 0) {
      throw createErrorWithCode(
        `No DNS results returned for ${normalizedHostname}`,
        'ENODATA'
      );
    }

    for (const addr of addresses) {
      if (addr.family !== 4 && addr.family !== 6) {
        throw createErrorWithCode(
          `Invalid address family returned for ${normalizedHostname}`,
          'EINVAL'
        );
      }
      if (this.ipBlocker.isBlockedIp(addr.address)) {
        throw createErrorWithCode(
          `Blocked IP detected for ${normalizedHostname}`,
          'EBLOCKED'
        );
      }
    }
  }

  private isBlockedHostname(hostname: string): boolean {
    if (this.security.blockedHosts.has(hostname)) return true;
    return this.blockedHostSuffixes.some((suffix) => hostname.endsWith(suffix));
  }

  private async assertNoBlockedCname(
    hostname: string,
    signal?: AbortSignal
  ): Promise<void> {
    let current = hostname;
    const seen = new Set<string>();

    for (let depth = 0; depth < CNAME_LOOKUP_MAX_DEPTH; depth += 1) {
      if (!current || seen.has(current)) return;
      seen.add(current);

      const cnames = await this.resolveCname(current, signal);
      if (cnames.length === 0) return;

      for (const cname of cnames) {
        if (this.isBlockedHostname(cname)) {
          throw createErrorWithCode(
            `Blocked DNS CNAME detected for ${hostname}: ${cname}`,
            'EBLOCKED'
          );
        }
      }

      current = cnames[0] ?? '';
    }
  }

  private async resolveCname(
    hostname: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    try {
      const resultPromise = dns.promises.resolveCname(hostname);
      const cnames = await withTimeout(
        resultPromise,
        DNS_LOOKUP_TIMEOUT_MS,
        () =>
          createErrorWithCode(
            `DNS CNAME lookup timed out for ${hostname}`,
            'ETIMEOUT'
          ),
        signal,
        createAbortSignalError
      );

      return cnames
        .map((value) => normalizeDnsName(value))
        .filter((value) => value.length > 0);
    } catch (error) {
      if (isError(error) && error.name === 'AbortError') {
        throw error;
      }

      if (
        isSystemError(error) &&
        (error.code === 'ENODATA' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'ENODOMAIN')
      ) {
        return [];
      }

      logDebug('DNS CNAME lookup failed; continuing with address lookup', {
        hostname,
        ...(isSystemError(error) ? { code: error.code } : {}),
      });
      return [];
    }
  }
}

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

function createCanceledFetchError(url: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
  });
}

function createTimeoutFetchError(url: string, timeoutMs: number): FetchError {
  return new FetchError(`Request timeout after ${timeoutMs}ms`, url, 504, {
    timeout: timeoutMs,
  });
}

function createRateLimitedFetchError(
  url: string,
  retryAfterHeader: string | null
): FetchError {
  return new FetchError('Too many requests', url, 429, {
    retryAfter: parseRetryAfter(retryAfterHeader),
  });
}

function createHttpFetchError(
  url: string,
  status: number,
  statusText: string
): FetchError {
  return new FetchError(`HTTP ${status}: ${statusText}`, url, status);
}

function createTooManyRedirectsFetchError(url: string): FetchError {
  return new FetchError('Too many redirects', url);
}

function createMissingRedirectLocationFetchError(url: string): FetchError {
  return new FetchError('Redirect response missing Location header', url);
}

function createNetworkFetchError(url: string, message?: string): FetchError {
  return new FetchError(
    `Network error: Could not reach ${url}`,
    url,
    undefined,
    message ? { message } : {}
  );
}

function createUnknownFetchError(url: string, message: string): FetchError {
  return new FetchError(message, url);
}

function createAbortedFetchError(url: string): FetchError {
  return new FetchError('Request was aborted during response read', url, 499, {
    reason: 'aborted',
  });
}

function isAbortError(error: unknown): boolean {
  return (
    isError(error) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
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

  if (isAbortError(error)) {
    return isTimeoutError(error)
      ? createTimeoutFetchError(url, timeoutMs)
      : createCanceledFetchError(url);
  }

  if (!isError(error)) return createUnknownFetchError(url, 'Unexpected error');

  if (!isSystemError(error)) return createNetworkFetchError(url, error.message);

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

  return new FetchError(
    `Network error: Could not reach ${url}`,
    url,
    undefined,
    {
      code,
      message: error.message,
    }
  );
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

const fetchChannel = diagnosticsChannel.channel('superfetch.fetch');

export interface FetchTelemetryContext {
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

    const event: FetchChannelEvent = {
      v: 1,
      type: 'start',
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
    };
    if (ctx.contextRequestId) event.contextRequestId = ctx.contextRequestId;
    if (ctx.operationId) event.operationId = ctx.operationId;
    this.publish(event);

    const logData: Record<string, unknown> = {
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
    };
    if (ctx.contextRequestId) logData.contextRequestId = ctx.contextRequestId;
    if (ctx.operationId) logData.operationId = ctx.operationId;
    this.logger.debug('HTTP Request', logData);

    return ctx;
  }

  recordResponse(
    context: FetchTelemetryContext,
    response: Response,
    contentSize?: number
  ): void {
    const duration = performance.now() - context.startTime;
    const durationLabel = `${Math.round(duration)}ms`;

    const event: FetchChannelEvent = {
      v: 1,
      type: 'end',
      requestId: context.requestId,
      status: response.status,
      duration,
    };
    if (context.contextRequestId)
      event.contextRequestId = context.contextRequestId;
    if (context.operationId) event.operationId = context.operationId;
    this.publish(event);

    const contentType = response.headers.get('content-type') ?? undefined;
    const contentLengthHeader = response.headers.get('content-length');
    const size =
      contentLengthHeader ??
      (contentSize === undefined ? undefined : String(contentSize));

    const logData: Record<string, unknown> = {
      requestId: context.requestId,
      status: response.status,
      url: context.url,
      duration: durationLabel,
    };
    if (context.contextRequestId)
      logData.contextRequestId = context.contextRequestId;
    if (context.operationId) logData.operationId = context.operationId;
    if (contentType) logData.contentType = contentType;
    if (size) logData.size = size;

    this.logger.debug('HTTP Response', logData);

    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      const warnData: Record<string, unknown> = {
        requestId: context.requestId,
        url: context.url,
        duration: durationLabel,
      };
      if (context.contextRequestId)
        warnData.contextRequestId = context.contextRequestId;
      if (context.operationId) warnData.operationId = context.operationId;

      this.logger.warn('Slow HTTP request detected', warnData);
    }
  }

  recordError(
    context: FetchTelemetryContext,
    error: unknown,
    status?: number
  ): void {
    const duration = performance.now() - context.startTime;
    const err = isError(error) ? error : new Error(String(error));
    const code = isSystemError(err) ? err.code : undefined;

    const event: Extract<FetchChannelEvent, { type: 'error' }> = {
      v: 1,
      type: 'error',
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      duration,
    };
    if (code !== undefined) event.code = code;
    if (status !== undefined) event.status = status;
    if (context.contextRequestId)
      event.contextRequestId = context.contextRequestId;
    if (context.operationId) event.operationId = context.operationId;
    this.publish(event);

    const logData: Record<string, unknown> = {
      requestId: context.requestId,
      url: context.url,
      status,
      code,
      error: err.message,
    };
    if (context.contextRequestId)
      logData.contextRequestId = context.contextRequestId;
    if (context.operationId) logData.operationId = context.operationId;

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

type NormalizeUrl = (urlString: string) => string;

type RedirectPreflight = (url: string, signal?: AbortSignal) => Promise<void>;

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
  ): Promise<{ response: Response; url: string }> {
    let currentUrl = url;
    const redirectLimit = Math.max(0, maxRedirects);

    for (
      let redirectCount = 0;
      redirectCount <= redirectLimit;
      redirectCount += 1
    ) {
      const { response, nextUrl } = await this.withRedirectErrorContext(
        currentUrl,
        async () => {
          if (this.preflight) {
            await this.preflight(currentUrl, init.signal ?? undefined);
          }
          return this.performFetchCycle(
            currentUrl,
            init,
            redirectLimit,
            redirectCount
          );
        }
      );

      if (!nextUrl) return { response, url: currentUrl };
      currentUrl = nextUrl;
    }

    throw createTooManyRedirectsFetchError(currentUrl);
  }

  private async performFetchCycle(
    currentUrl: string,
    init: RequestInit,
    redirectLimit: number,
    redirectCount: number
  ): Promise<{ response: Response; nextUrl?: string }> {
    const response = await this.fetchFn(currentUrl, {
      ...init,
      redirect: 'manual',
    });

    if (!isRedirectStatus(response.status)) return { response };

    this.assertRedirectWithinLimit(
      response,
      currentUrl,
      redirectLimit,
      redirectCount
    );

    const location = this.getRedirectLocation(response, currentUrl);
    cancelResponseBody(response);

    return {
      response,
      nextUrl: this.resolveRedirectTarget(currentUrl, location),
    };
  }

  private assertRedirectWithinLimit(
    response: Response,
    currentUrl: string,
    redirectLimit: number,
    redirectCount: number
  ): void {
    if (redirectCount < redirectLimit) return;
    cancelResponseBody(response);
    throw createTooManyRedirectsFetchError(currentUrl);
  }

  private getRedirectLocation(response: Response, currentUrl: string): string {
    const location = response.headers.get('location');
    if (location) return location;

    cancelResponseBody(response);
    throw createMissingRedirectLocationFetchError(currentUrl);
  }

  private resolveRedirectTarget(baseUrl: string, location: string): string {
    let resolved: URL;
    try {
      resolved = new URL(location, baseUrl);
    } catch {
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
    (error as Record<string, unknown>).requestUrl = url;
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

function createDecoder(encoding: string | undefined): TextDecoder {
  if (!encoding) return new TextDecoder('utf-8');

  try {
    return new TextDecoder(encoding);
  } catch {
    return new TextDecoder('utf-8');
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

const BOM_SIGNATURES: readonly {
  bytes: readonly number[];
  encoding: string;
}[] = [
  // 4-byte BOMs must come first to avoid false matches with 2-byte prefixes
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

function detectBomEncoding(buffer: Uint8Array): string | undefined {
  for (const { bytes, encoding } of BOM_SIGNATURES) {
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

function extractHtmlCharset(headSnippet: string): string | undefined {
  const lower = headSnippet.toLowerCase();
  const charsetToken = 'charset=';
  const charsetIdx = lower.indexOf(charsetToken);
  if (charsetIdx === -1) return undefined;

  const valueStart = charsetIdx + charsetToken.length;
  const charset = readQuotedValue(headSnippet, valueStart);
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

  const encodingToken = 'encoding=';
  const encodingIdx = declarationLower.indexOf(encodingToken);
  if (encodingIdx === -1) return undefined;

  const valueStart = encodingIdx + encodingToken.length;
  const encoding = readQuotedValue(declaration, valueStart);
  return encoding ? encoding.toLowerCase() : undefined;
}

function detectHtmlDeclaredEncoding(buffer: Uint8Array): string | undefined {
  const scanSize = Math.min(buffer.length, 8_192);
  if (scanSize === 0) return undefined;

  const headSnippet = Buffer.from(
    buffer.buffer,
    buffer.byteOffset,
    scanSize
  ).toString('latin1');

  return extractHtmlCharset(headSnippet) ?? extractXmlEncoding(headSnippet);
}

function resolveEncoding(
  declaredEncoding: string | undefined,
  sample: Uint8Array
): string | undefined {
  const bomEncoding = detectBomEncoding(sample);
  if (bomEncoding) return bomEncoding;

  if (declaredEncoding) return declaredEncoding;

  return detectHtmlDeclaredEncoding(sample);
}

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

function hasNullByte(buffer: Uint8Array, limit: number): boolean {
  const checkLen = Math.min(buffer.length, limit);
  return buffer.subarray(0, checkLen).includes(0x00);
}

function isBinaryContent(buffer: Uint8Array, encoding?: string): boolean {
  for (const signature of BINARY_SIGNATURES) {
    if (startsWithBytes(buffer, signature)) return true;
  }

  return !isUnicodeWideEncoding(encoding) && hasNullByte(buffer, 1000);
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
      throw createAbortedFetchError(url);
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
    if (signal?.aborted) throw createCanceledFetchError(url);

    const limit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;

    let buffer: Uint8Array;
    let truncated = false;

    try {
      // Try safe blob slicing if available (Node 18+) to avoid OOM
      const blob = await response.blob();
      if (Number.isFinite(limit) && blob.size > limit) {
        const sliced = blob.slice(0, limit);
        buffer = new Uint8Array(await sliced.arrayBuffer());
        truncated = true;
      } else {
        buffer = new Uint8Array(await blob.arrayBuffer());
      }
    } catch {
      // Fallback if blob() fails
      const arrayBuffer = await response.arrayBuffer();
      const length = Math.min(arrayBuffer.byteLength, limit);
      buffer = new Uint8Array(arrayBuffer, 0, length);
      truncated = Number.isFinite(limit) && arrayBuffer.byteLength > limit;
    }

    const effectiveEncoding =
      resolveEncoding(encoding, buffer) ?? encoding ?? 'utf-8';

    if (isBinaryContent(buffer, effectiveEncoding)) {
      throw new FetchError(
        'Detailed content type check failed: binary content detected',
        url,
        500,
        { reason: 'binary_content_detected' }
      );
    }

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
    let effectiveEncoding = encoding ?? 'utf-8';
    let checkedBinary = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const source = Readable.fromWeb(
      stream as unknown as NodeReadableStream<Uint8Array>
    );

    const guard = new Transform({
      transform(this: Transform, chunk, _encoding, callback): void {
        try {
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                (chunk as Uint8Array).buffer,
                (chunk as Uint8Array).byteOffset,
                (chunk as Uint8Array).byteLength
              );

          if (!checkedBinary) {
            checkedBinary = true;
            effectiveEncoding =
              resolveEncoding(encoding, buf) ?? encoding ?? 'utf-8';
            if (isBinaryContent(buf, effectiveEncoding)) {
              callback(
                new FetchError(
                  'Detailed content type check failed: binary content detected',
                  url,
                  500,
                  { reason: 'binary_content_detected' }
                )
              );
              return;
            }
          }

          const newTotal = total + buf.length;
          if (newTotal > byteLimit) {
            const remaining = byteLimit - total;
            if (remaining > 0) {
              const slice = buf.subarray(0, remaining);
              total += remaining;
              if (captureChunks) chunks.push(slice);
              this.push(slice);
            }
            callback(new MaxBytesError());
            return;
          }

          total = newTotal;
          if (captureChunks) chunks.push(buf);
          callback(null, buf);
        } catch (error: unknown) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });

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
        encoding: effectiveEncoding,
        size: total,
        truncated: false,
      };
    } catch (error: unknown) {
      if (signal?.aborted) throw createAbortedFetchError(url);
      if (error instanceof FetchError) throw error;
      if (error instanceof MaxBytesError) {
        source.destroy();
        guard.destroy();
        return {
          buffer: Buffer.concat(chunks, total),
          encoding: effectiveEncoding,
          size: total,
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

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

function buildHeaders(): Record<string, string> {
  return DEFAULT_HEADERS;
}

function buildRequestSignal(
  timeoutMs: number,
  external?: AbortSignal
): AbortSignal | undefined {
  if (timeoutMs <= 0) return external;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal;
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

function resolveResponseError(
  response: Response,
  finalUrl: string
): FetchError | null {
  if (response.status === 429) {
    return createRateLimitedFetchError(
      finalUrl,
      response.headers.get('retry-after')
    );
  }

  return response.ok
    ? null
    : createHttpFetchError(finalUrl, response.status, response.statusText);
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
  const tokens: string[] = [];
  let i = 0;
  const len = value.length;

  while (i < len) {
    while (
      i < len &&
      (value.charCodeAt(i) === 44 || value.charCodeAt(i) <= 32)
    ) {
      i += 1;
    }
    if (i >= len) break;

    const start = i;
    while (i < len && value.charCodeAt(i) !== 44) i += 1;

    const token = value.slice(start, i).trim().toLowerCase();
    if (token) tokens.push(token);

    if (i < len && value.charCodeAt(i) === 44) i += 1;
  }

  return tokens;
}

function parseSingleContentEncoding(
  value: string | null
): string | null | undefined {
  if (!value) return null;

  const tokens = extractEncodingTokens(value);

  if (tokens.length === 0) return null;
  if (tokens.length > 1) return undefined;

  return tokens[0] ?? null;
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

function createPumpedStream(
  initialChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (initialChunk.byteLength > 0) {
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

function isLikelyCompressed(
  chunk: Uint8Array,
  encoding: 'gzip' | 'deflate' | 'br'
): boolean {
  if (chunk.byteLength === 0) return false;

  if (encoding === 'gzip') {
    return chunk.byteLength >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b;
  }

  if (encoding === 'deflate') {
    if (chunk.byteLength < 2) return false;
    const byte0 = chunk[0] ?? 0;
    const byte1 = chunk[1] ?? 0;
    const cm = byte0 & 0x0f;
    if (cm !== 8) return false;
    return (byte0 * 256 + byte1) % 31 === 0;
  }
  let nonPrintable = 0;
  const limit = Math.min(chunk.length, 50);
  for (let i = 0; i < limit; i += 1) {
    const b = chunk[i] ?? 0;
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) nonPrintable += 1;
  }
  return nonPrintable / limit > 0.1;
}

async function decodeResponseIfNeeded(
  response: Response,
  url: string,
  signal?: AbortSignal
): Promise<Response> {
  const encodingHeader = response.headers.get('content-encoding');
  const encoding = parseSingleContentEncoding(encodingHeader);

  if (encoding === null || encoding === 'identity') return response;
  if (encoding === undefined) {
    throw createUnsupportedContentEncodingError(url, encodingHeader ?? '');
  }

  if (encoding !== 'gzip' && encoding !== 'deflate' && encoding !== 'br') {
    throw createUnsupportedContentEncodingError(
      url,
      encodingHeader ?? encoding
    );
  }

  if (!response.body) return response;

  // Peek at first chunk to check if actually compressed
  const reader = response.body.getReader();
  let initialChunk: Uint8Array;
  try {
    const { done, value } = await reader.read();
    if (done) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    initialChunk = value;
  } catch (error) {
    // If read fails, throw properly
    throw new FetchError(
      `Failed to read response body: ${isError(error) ? error.message : String(error)}`,
      url,
      502
    );
  }

  if (!isLikelyCompressed(initialChunk, encoding)) {
    const body = createPumpedStream(initialChunk, reader);
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Set up decompression
  let decompressor: ReturnType<typeof createGunzip> | null = null;
  switch (encoding) {
    case 'gzip':
      decompressor = createGunzip();
      break;
    case 'deflate':
      decompressor = createInflate();
      break;
    case 'br':
      decompressor = createBrotliDecompress();
      break;
    default:
      // Should have been caught by parseSingleContentEncoding check, but safe fallback
      decompressor = null;
  }

  if (!decompressor) {
    // Should be unreachable if encoding valid
    throw createUnsupportedContentEncodingError(
      url,
      encodingHeader ?? encoding
    );
  }

  const sourceStream = Readable.fromWeb(
    createPumpedStream(
      initialChunk,
      reader
    ) as unknown as NodeReadableStream<Uint8Array>
  );
  const decodedNodeStream = new PassThrough();
  const pipelinePromise = pipeline(
    sourceStream,
    decompressor,
    decodedNodeStream
  );

  const abortHandler = (): void => {
    sourceStream.destroy();
    decompressor.destroy();
    decodedNodeStream.destroy();
  };

  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  void pipelinePromise.catch((error: unknown) => {
    decodedNodeStream.destroy(
      error instanceof Error ? error : new Error(String(error))
    );
  });

  const decodedBody = Readable.toWeb(
    decodedNodeStream
  ) as unknown as ReadableStream<Uint8Array>;

  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');

  if (signal) {
    void finished(decodedNodeStream, { cleanup: true }).finally(() => {
      signal.removeEventListener('abort', abortHandler);
    });
  }

  return new Response(decodedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

async function readAndRecordDecodedResponse(
  response: Response,
  finalUrl: string,
  ctx: FetchTelemetryContext,
  telemetry: FetchTelemetry,
  reader: ResponseTextReader,
  maxBytes: number,
  mode: 'text' | 'buffer',
  signal?: AbortSignal
): Promise<ReadDecodedResponseResult> {
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const decodedResponse = await decodeResponseIfNeeded(
    response,
    finalUrl,
    signal
  );

  const contentType = decodedResponse.headers.get('content-type');
  assertSupportedContentType(contentType, finalUrl);

  const declaredEncoding = getCharsetFromContentType(contentType ?? null);

  if (mode === 'text') {
    const { text, size, truncated } = await reader.read(
      decodedResponse,
      finalUrl,
      maxBytes,
      signal,
      declaredEncoding
    );
    telemetry.recordResponse(ctx, decodedResponse, size);
    return { kind: 'text', text, size, truncated };
  }

  const { buffer, encoding, size, truncated } = await reader.readBuffer(
    decodedResponse,
    finalUrl,
    maxBytes,
    signal,
    declaredEncoding
  );
  telemetry.recordResponse(ctx, decodedResponse, size);
  return { kind: 'buffer', buffer, encoding, size, truncated };
}

type FetcherConfig = typeof config.fetcher;

type HostnamePreflight = (url: string, signal?: AbortSignal) => Promise<void>;

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw createErrorWithCode('Invalid URL', 'EINVAL');
  }
}

function createDnsPreflight(dnsResolver: SafeDnsResolver): HostnamePreflight {
  return async (url: string, signal?: AbortSignal) => {
    const hostname = extractHostname(url);
    await dnsResolver.assertSafeHostname(hostname, signal);
  };
}

class HttpFetcher {
  constructor(
    private readonly fetcherConfig: FetcherConfig,
    private readonly dnsResolver: SafeDnsResolver,
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
  ): Promise<{ buffer: Uint8Array; encoding: string; truncated: boolean }> {
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
  ): Promise<{ buffer: Uint8Array; encoding: string; truncated: boolean }>;
  private async fetchNormalized(
    normalizedUrl: string,
    mode: 'text' | 'buffer',
    options?: FetchOptions
  ): Promise<
    string | { buffer: Uint8Array; encoding: string; truncated: boolean }
  > {
    const hostname = extractHostname(normalizedUrl);

    const timeoutMs = this.fetcherConfig.timeout;
    const headers = buildHeaders();
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const init = buildRequestInit(headers, signal);

    const ctx = this.telemetry.start(normalizedUrl, 'GET');

    try {
      await this.dnsResolver.assertSafeHostname(hostname, signal ?? undefined);

      const { response, url: finalUrl } =
        await this.redirectFollower.fetchWithRedirects(
          normalizedUrl,
          init,
          this.fetcherConfig.maxRedirects
        );

      ctx.url = this.telemetry.redact(finalUrl);

      const payload = await readAndRecordDecodedResponse(
        response,
        finalUrl,
        ctx,
        this.telemetry,
        this.reader,
        this.fetcherConfig.maxContentLength,
        mode,
        init.signal ?? undefined
      );

      if (payload.kind === 'text') return payload.text;

      return {
        buffer: payload.buffer,
        encoding: payload.encoding,
        truncated: payload.truncated,
      };
    } catch (error: unknown) {
      const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
      ctx.url = this.telemetry.redact(mapped.url);
      this.telemetry.recordError(ctx, mapped, mapped.statusCode);
      throw mapped;
    }
  }
}

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
const telemetry = new FetchTelemetry(
  defaultLogger,
  defaultContext,
  defaultRedactor
);
const normalizeRedirectUrl = (url: string): string =>
  urlNormalizer.validateAndNormalize(url);
const dnsPreflight = createDnsPreflight(dnsResolver);

// Redirect follower with per-hop DNS preflight.
const secureRedirectFollower = new RedirectFollower(
  defaultFetch,
  normalizeRedirectUrl,
  dnsPreflight
);

const responseReader = new ResponseTextReader();
const httpFetcher = new HttpFetcher(
  config.fetcher,
  dnsResolver,
  secureRedirectFollower,
  responseReader,
  telemetry
);

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
): Promise<{ response: Response; url: string }> {
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

export async function readResponseBuffer(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
  encoding?: string
): Promise<{ buffer: Uint8Array; encoding: string; size: number }> {
  const decodedResponse = await decodeResponseIfNeeded(response, url, signal);
  const {
    buffer,
    encoding: resolvedEncoding,
    size,
  } = await responseReader.readBuffer(
    decodedResponse,
    url,
    maxBytes,
    signal,
    encoding
  );
  return { buffer, encoding: resolvedEncoding, size };
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
): Promise<{ buffer: Uint8Array; encoding: string; truncated: boolean }> {
  return httpFetcher.fetchNormalizedUrlBuffer(normalizedUrl, options);
}
