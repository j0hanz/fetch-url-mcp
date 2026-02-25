import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable, Transform } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { finished, pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { Agent, type Dispatcher } from 'undici';

import { config } from './config.js';
import { createErrorWithCode, FetchError, isSystemError } from './errors.js';
import {
  decodeBuffer,
  getCharsetFromContentType,
  isBinaryContent,
  resolveEncoding,
} from './fetch-content.js';
import { toNodeReadableStream, toWebReadableStream } from './fetch-stream.js';
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

interface FetchOptions {
  signal?: AbortSignal;
}

interface TransformResult {
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

function isLocalFetchAllowed(): boolean {
  return process.env['ALLOW_LOCAL_FETCH'] === 'true';
}

class IpBlocker {
  private readonly blockList = createDefaultBlockList();

  constructor(private readonly security: SecurityConfig) {}

  isBlockedIp(candidate: string): boolean {
    const normalized = candidate.trim().toLowerCase();
    if (isCloudMetadataHost(normalized)) return true;
    if (isLocalFetchAllowed()) return false;
    if (!normalized) return false;
    if (this.security.blockedHosts.has(normalized)) return true;

    const normalizedIp = normalizeIpForBlockList(normalized);
    return normalizedIp
      ? this.blockList.check(normalizedIp.ip, normalizedIp.family)
      : false;
  }
}

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

function createValidationError(message: string): Error {
  return createErrorWithCode(message, VALIDATION_ERROR_CODE);
}

const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];

// This list is not exhaustive but covers the most common cloud metadata endpoints.
const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure
  'metadata.google.internal', // GCP
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IPv6
]);

function isCloudMetadataHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(lowered)) return true;
  const normalized = normalizeIpForBlockList(lowered);
  return normalized !== null && CLOUD_METADATA_HOSTS.has(normalized.ip);
}

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
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');

    if (!hostname) {
      throw createValidationError('URL must have a valid hostname');
    }

    return hostname;
  }

  private assertHostnameAllowed(hostname: string): void {
    if (isCloudMetadataHost(hostname)) {
      throw createValidationError(
        `Blocked host: ${hostname}. Cloud metadata endpoints are not allowed`
      );
    }

    if (!isLocalFetchAllowed()) {
      if (this.security.blockedHosts.has(hostname)) {
        throw createValidationError(
          `Blocked host: ${hostname}. Internal hosts are not allowed`
        );
      }

      if (this.ipBlocker.isBlockedIp(hostname)) {
        throw createValidationError(
          `Blocked IP range: ${hostname}. Private IPs are not allowed`
        );
      }
    }

    if (this.blockedHostSuffixes.some((suffix) => hostname.endsWith(suffix))) {
      throw createValidationError(
        `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`
      );
    }
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
    const hashIndex = urlString.indexOf('#');
    const queryIndex = urlString.indexOf('?');
    const endIndex = Math.min(
      queryIndex === -1 ? urlString.length : queryIndex,
      hashIndex === -1 ? urlString.length : hashIndex
    );

    const hash = hashIndex !== -1 ? urlString.slice(hashIndex) : '';
    return { base: urlString.slice(0, endIndex), hash };
  }

  private tryTransformWithUrl(
    base: string,
    hash: string,
    preParsed?: URL
  ): { url: string; platform: string } | null {
    let parsed: URL | null = preParsed ?? null;

    if (!parsed) {
      try {
        parsed = new URL(base);
      } catch {
        // Ignore invalid URLs
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
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
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

  async resolveAndValidate(
    hostname: string,
    signal?: AbortSignal
  ): Promise<string> {
    const normalizedHostname = normalizeDnsName(
      hostname.replace(/^\[|\]$/g, '')
    );

    if (!normalizedHostname) {
      throw createErrorWithCode('Invalid hostname provided', 'EINVAL');
    }

    if (signal?.aborted) {
      throw createAbortSignalError();
    }

    if (this.isBlockedHostname(normalizedHostname)) {
      throw createErrorWithCode(
        `Blocked host: ${normalizedHostname}. Internal hosts are not allowed`,
        'EBLOCKED'
      );
    }

    if (isIP(normalizedHostname)) {
      if (isCloudMetadataHost(normalizedHostname)) {
        throw createErrorWithCode(
          `Blocked IP range: ${normalizedHostname}. Cloud metadata endpoints are not allowed`,
          'EBLOCKED'
        );
      }
      if (
        process.env['ALLOW_LOCAL_FETCH'] !== 'true' &&
        this.ipBlocker.isBlockedIp(normalizedHostname)
      ) {
        throw createErrorWithCode(
          `Blocked IP range: ${normalizedHostname}. Private IPs are not allowed`,
          'EBLOCKED'
        );
      }
      return normalizedHostname;
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

    if (addresses.length === 0 || !addresses[0]) {
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
      if (isCloudMetadataHost(addr.address)) {
        throw createErrorWithCode(
          `Blocked IP detected for ${normalizedHostname}`,
          'EBLOCKED'
        );
      }
      if (!isLocalFetchAllowed() && this.ipBlocker.isBlockedIp(addr.address)) {
        throw createErrorWithCode(
          `Blocked IP detected for ${normalizedHostname}`,
          'EBLOCKED'
        );
      }
    }

    return addresses[0].address;
  }

  private isBlockedHostname(hostname: string): boolean {
    if (isCloudMetadataHost(hostname)) return true;
    if (isLocalFetchAllowed()) return false;
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
  }
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

    const ctxFields = this.contextFields(ctx);
    this.publish({
      v: 1,
      type: 'start',
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...ctxFields,
    });

    this.logger.debug('HTTP Request', {
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...ctxFields,
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
    const ctxFields = this.contextFields(context);

    this.publish({
      v: 1,
      type: 'end',
      requestId: context.requestId,
      status: response.status,
      duration,
      ...ctxFields,
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
      ...ctxFields,
      ...(contentType ? { contentType } : {}),
      ...(size ? { size } : {}),
    });

    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      this.logger.warn('Slow HTTP request detected', {
        requestId: context.requestId,
        url: context.url,
        duration: durationLabel,
        ...ctxFields,
      });
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
    const ctxFields = this.contextFields(context);

    this.publish({
      v: 1,
      type: 'error',
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      duration,
      ...(code !== undefined ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      ...ctxFields,
    });

    const logData: Record<string, unknown> = {
      requestId: context.requestId,
      url: context.url,
      status,
      code,
      error: err.message,
      ...ctxFields,
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

type RedirectPreflight = (url: string, signal?: AbortSignal) => Promise<string>;

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
        }
      );

      if (!nextUrl) return { response, url: currentUrl };
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
  ): Promise<{ response: Response; nextUrl?: string }> {
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      ...init,
      redirect: 'manual' as RequestRedirect,
    };
    if (ipAddress) {
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
        },
        pipelining: 1,
        connections: 1,
        keepAliveTimeout: 1000,
        keepAliveMaxTimeout: 1000,
      });
      fetchInit.dispatcher = agent;
    }

    const response = await this.fetchFn(currentUrl, fetchInit);

    if (!isRedirectStatus(response.status)) return { response };

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
  }

  private getRedirectLocation(response: Response, currentUrl: string): string {
    const location = response.headers.get('location');
    if (location) return location;

    cancelResponseBody(response);
    throw createFetchError({ kind: 'missing-redirect-location' }, currentUrl);
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
    let encodingResolved = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const source = Readable.fromWeb(
      toNodeReadableStream(stream, url, 'response:read-stream-buffer')
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

          if (!encodingResolved) {
            encodingResolved = true;
            effectiveEncoding =
              resolveEncoding(encoding, buf) ?? encoding ?? 'utf-8';
          }

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
      if (signal?.aborted) throw createFetchError({ kind: 'aborted' }, url);
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

async function decodeResponseIfNeeded(
  response: Response,
  url: string,
  signal?: AbortSignal
): Promise<Response> {
  const encodingHeader = response.headers.get('content-encoding');
  const parsedEncodings = parseContentEncodings(encodingHeader);
  if (!parsedEncodings) return response;

  const encodings = parsedEncodings.filter((token) => token !== 'identity');
  if (encodings.length === 0) return response;

  for (const encoding of encodings) {
    if (!isSupportedContentEncoding(encoding)) {
      throw createUnsupportedContentEncodingError(
        url,
        encodingHeader ?? encoding
      );
    }
  }

  if (!response.body) return response;
  const [decodeBranch, passthroughBranch] = response.body.tee();

  const decodeOrder = encodings
    .slice()
    .reverse()
    .filter(isSupportedContentEncoding);

  const decompressors = decodeOrder.map((encoding) =>
    createDecompressor(encoding)
  );
  const decodeSource = Readable.fromWeb(
    toNodeReadableStream(decodeBranch, url, 'response:decode-content-encoding')
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

  const abortDecodePipeline = (): void => {
    decodeSource.destroy();
    for (const decompressor of decompressors) {
      decompressor.destroy();
    }
    decodedNodeStream.destroy();
  };

  if (signal) {
    signal.addEventListener('abort', abortDecodePipeline, { once: true });
  }

  void decodedPipeline.catch((error: unknown) => {
    decodedNodeStream.destroy(
      error instanceof Error ? error : new Error(String(error))
    );
  });

  const decodedBodyStream = toWebReadableStream(
    decodedNodeStream,
    url,
    'response:decode-content-encoding'
  );
  const decodedReader = decodedBodyStream.getReader();

  const clearAbortListener = (): void => {
    if (!signal) return;
    signal.removeEventListener('abort', abortDecodePipeline);
  };

  try {
    const first = await decodedReader.read();
    if (first.done) {
      clearAbortListener();
      void passthroughBranch.cancel().catch(() => undefined);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    void passthroughBranch.cancel().catch(() => undefined);
    const body = createPumpedStream(first.value, decodedReader);

    if (signal) {
      void finished(decodedNodeStream, { cleanup: true })
        .catch(() => {})
        .finally(() => {
          clearAbortListener();
        });
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error: unknown) {
    clearAbortListener();
    abortDecodePipeline();
    void decodedReader.cancel(error).catch(() => undefined);

    logDebug('Content-Encoding decode failed; using passthrough body', {
      url: redactUrl(url),
      encoding: encodingHeader ?? encodings.join(','),
      error: isError(error) ? error.message : String(error),
    });

    return new Response(passthroughBranch, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
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
interface FetchBufferResult {
  buffer: Uint8Array;
  encoding: string;
  truncated: boolean;
  finalUrl: string;
}
type FetchReadMode = 'text' | 'buffer';
type FetchReadResult = string | FetchBufferResult;

type HostnamePreflight = (url: string, signal?: AbortSignal) => Promise<string>;

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
    return await dnsResolver.resolveAndValidate(hostname, signal);
  };
}

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
    const headers = buildHeaders();
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const init = buildRequestInit(headers, signal);

    const ctx = this.telemetry.start(normalizedUrl, 'GET');

    try {
      const { response, url: finalUrl } =
        await this.redirectFollower.fetchWithRedirects(
          normalizedUrl,
          init,
          this.fetcherConfig.maxRedirects
        );

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
      const payload = await readAndRecordDecodedResponse(
        response,
        finalUrl,
        ctx,
        this.telemetry,
        this.reader,
        this.fetcherConfig.maxContentLength,
        mode,
        signal
      );

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
