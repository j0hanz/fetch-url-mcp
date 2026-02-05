import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import { config } from './config.js';
import { createErrorWithCode, FetchError, isSystemError } from './errors.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logWarn,
  redactUrl,
} from './observability.js';
import { isObject } from './type-guards.js';

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

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

type IpSegment = number | string;

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function buildIpv6(parts: readonly IpSegment[]): string {
  return parts.map(String).join(':');
}

const IPV6_ZERO = buildIpv6([0, 0, 0, 0, 0, 0, 0, 0]);
const IPV6_LOOPBACK = buildIpv6([0, 0, 0, 0, 0, 0, 0, 1]);
const IPV6_64_FF9B = buildIpv6(['64', 'ff9b', 0, 0, 0, 0, 0, 0]);
const IPV6_64_FF9B_1 = buildIpv6(['64', 'ff9b', 1, 0, 0, 0, 0, 0]);
const IPV6_2001 = buildIpv6(['2001', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_2002 = buildIpv6(['2002', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FC00 = buildIpv6(['fc00', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FE80 = buildIpv6(['fe80', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FF00 = buildIpv6(['ff00', 0, 0, 0, 0, 0, 0, 0]);

type BlockedSubnet = Readonly<{
  subnet: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}>;

const BLOCKED_SUBNETS: readonly BlockedSubnet[] = [
  { subnet: buildIpv4([0, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([10, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([100, 64, 0, 0]), prefix: 10, family: 'ipv4' },
  { subnet: buildIpv4([127, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([169, 254, 0, 0]), prefix: 16, family: 'ipv4' },
  { subnet: buildIpv4([172, 16, 0, 0]), prefix: 12, family: 'ipv4' },
  { subnet: buildIpv4([192, 168, 0, 0]), prefix: 16, family: 'ipv4' },
  { subnet: buildIpv4([224, 0, 0, 0]), prefix: 4, family: 'ipv4' },
  { subnet: buildIpv4([240, 0, 0, 0]), prefix: 4, family: 'ipv4' },
  { subnet: IPV6_ZERO, prefix: 128, family: 'ipv6' },
  { subnet: IPV6_LOOPBACK, prefix: 128, family: 'ipv6' },
  { subnet: IPV6_64_FF9B, prefix: 96, family: 'ipv6' },
  { subnet: IPV6_64_FF9B_1, prefix: 48, family: 'ipv6' },
  { subnet: IPV6_2001, prefix: 32, family: 'ipv6' },
  { subnet: IPV6_2002, prefix: 16, family: 'ipv6' },
  { subnet: IPV6_FC00, prefix: 7, family: 'ipv6' },
  { subnet: IPV6_FE80, prefix: 10, family: 'ipv6' },
  { subnet: IPV6_FF00, prefix: 8, family: 'ipv6' },
];

function createSubnetBlockList(subnets: readonly BlockedSubnet[]): BlockList {
  const list = new BlockList();
  for (const entry of subnets) {
    list.addSubnet(entry.subnet, entry.prefix, entry.family);
  }
  return list;
}

type SecurityConfig = typeof config.security;

class IpBlocker {
  private readonly blockList: BlockList;

  constructor(private readonly security: SecurityConfig) {
    this.blockList = createSubnetBlockList(BLOCKED_SUBNETS);
  }

  isBlockedIp(candidate: string): boolean {
    if (this.security.blockedHosts.has(candidate)) return true;

    const ipType = isIP(candidate);
    if (ipType !== 4 && ipType !== 6) return false;

    const normalized = candidate.toLowerCase();
    if (this.isBlockedBySubnet(normalized, ipType)) return true;

    return (
      this.security.blockedIpPattern.test(normalized) ||
      this.security.blockedIpv4MappedPattern.test(normalized)
    );
  }

  private isBlockedBySubnet(ip: string, ipType: 4 | 6): boolean {
    const family = ipType === 4 ? 'ipv4' : 'ipv6';
    return this.blockList.check(ip, family);
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
    this.assertUrlLength(trimmedUrl);

    const url = this.parseUrl(trimmedUrl);
    this.assertHttpProtocol(url);
    this.assertNoCredentials(url);

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

  private assertUrlLength(url: string): void {
    if (url.length <= this.constants.maxUrlLength) return;
    throw createValidationError(
      `URL exceeds maximum length of ${this.constants.maxUrlLength} characters`
    );
  }

  private parseUrl(urlString: string): URL {
    if (!URL.canParse(urlString)) {
      throw createValidationError('Invalid URL format');
    }
    return new URL(urlString);
  }

  private assertHttpProtocol(url: URL): void {
    if (url.protocol === 'http:' || url.protocol === 'https:') return;
    throw createValidationError(
      `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`
    );
  }

  private assertNoCredentials(url: URL): void {
    if (!url.username && !url.password) return;
    throw createValidationError(
      'URLs with embedded credentials are not allowed'
    );
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

interface TransformRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly transform: (match: RegExpExecArray) => string;
}

function getMatchGroup(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

const GITHUB_BLOB_RULE: TransformRule = {
  name: 'github',
  pattern:
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i,
  transform: (match) => {
    const owner = getMatchGroup(match, 1);
    const repo = getMatchGroup(match, 2);
    const branch = getMatchGroup(match, 3);
    const path = getMatchGroup(match, 4);
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  },
};

const GITHUB_GIST_RULE: TransformRule = {
  name: 'github-gist',
  pattern:
    /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)(?:#file-(.+)|\/raw\/([^/]+))?$/i,
  transform: (match) => {
    const user = getMatchGroup(match, 1);
    const gistId = getMatchGroup(match, 2);
    const hashFile = match[3];
    const rawFile = match[4];
    const filename = rawFile ?? hashFile?.replace(/-/g, '.');
    const filePath = filename ? `/${filename}` : '';
    return `https://gist.githubusercontent.com/${user}/${gistId}/raw${filePath}`;
  },
};

const GITLAB_BLOB_RULE: TransformRule = {
  name: 'gitlab',
  pattern:
    /^(https?:\/\/(?:[^/]+\.)?gitlab\.com\/[^/]+\/[^/]+)\/-\/blob\/([^/]+)\/(.+)$/i,
  transform: (match) => {
    const baseUrl = getMatchGroup(match, 1);
    const branch = getMatchGroup(match, 2);
    const path = getMatchGroup(match, 3);
    return `${baseUrl}/-/raw/${branch}/${path}`;
  },
};

const BITBUCKET_SRC_RULE: TransformRule = {
  name: 'bitbucket',
  pattern:
    /^(https?:\/\/(?:www\.)?bitbucket\.org\/[^/]+\/[^/]+)\/src\/([^/]+)\/(.+)$/i,
  transform: (match) => {
    const baseUrl = getMatchGroup(match, 1);
    const branch = getMatchGroup(match, 2);
    const path = getMatchGroup(match, 3);
    return `${baseUrl}/raw/${branch}/${path}`;
  },
};

const TRANSFORM_RULES: readonly TransformRule[] = [
  GITHUB_BLOB_RULE,
  GITHUB_GIST_RULE,
  GITLAB_BLOB_RULE,
  BITBUCKET_SRC_RULE,
];

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

    const { base, hash } = this.splitParams(url);
    const match = this.applyRules(base, hash);
    if (!match) return { url, transformed: false };

    this.logger.debug('URL transformed to raw content URL', {
      platform: match.platform,
      original: url.substring(0, 100),
      transformed: match.url.substring(0, 100),
    });

    return { url: match.url, transformed: true, platform: match.platform };
  }

  isRawTextContentUrl(url: string): boolean {
    if (!url) return false;
    if (this.isRawUrl(url)) return true;

    const { base } = this.splitParams(url);
    const lowerBase = base.toLowerCase();
    const lastDot = lowerBase.lastIndexOf('.');
    if (lastDot === -1) return false;

    return RAW_TEXT_EXTENSIONS.has(lowerBase.slice(lastDot));
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

  private splitParams(url: string): { base: string; hash: string } {
    const hashIndex = url.indexOf('#');
    const queryIndex = url.indexOf('?');
    const endIndex = Math.min(
      queryIndex === -1 ? url.length : queryIndex,
      hashIndex === -1 ? url.length : hashIndex
    );

    const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
    return { base: url.slice(0, endIndex), hash };
  }

  private applyRules(
    base: string,
    hash: string
  ): { url: string; platform: string } | null {
    for (const rule of TRANSFORM_RULES) {
      const urlToMatch =
        rule.name === 'github-gist' && hash.startsWith('#file-')
          ? base + hash
          : base;

      const match = rule.pattern.exec(urlToMatch);
      if (match) return { url: rule.transform(match), platform: rule.name };
    }

    return null;
  }
}

const DNS_LOOKUP_TIMEOUT_MS = 5000;

interface AbortRace {
  abortPromise: Promise<never> | null;
  cleanup: () => void;
}

function createAbortRace(
  signal: AbortSignal | undefined,
  onAbort: () => Error
): AbortRace {
  if (!signal) {
    return { abortPromise: null, cleanup: () => {} };
  }

  if (signal.aborted) {
    return {
      abortPromise: Promise.reject(onAbort()),
      cleanup: () => {},
    };
  }

  let abortListener: (() => void) | null = null;

  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      reject(onAbort());
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });

  const cleanup = (): void => {
    if (!abortListener) return;
    try {
      signal.removeEventListener('abort', abortListener);
    } catch {
      // Best-effort cleanup.
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
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    timer.unref();
  });

  const abortRace = createAbortRace(
    signal,
    onAbort ?? (() => new Error('Request was canceled'))
  );

  try {
    return await Promise.race(
      abortRace.abortPromise
        ? [promise, timeout, abortRace.abortPromise]
        : [promise, timeout]
    );
  } finally {
    if (timer) clearTimeout(timer);
    abortRace.cleanup();
  }
}

class SafeDnsResolver {
  constructor(private readonly ipBlocker: IpBlocker) {}

  async assertSafeHostname(
    hostname: string,
    signal?: AbortSignal
  ): Promise<void> {
    const resultPromise = dns.promises.lookup(hostname, {
      all: true,
      order: 'verbatim',
    });

    const addresses = await withTimeout(
      resultPromise,
      DNS_LOOKUP_TIMEOUT_MS,
      () =>
        createErrorWithCode(`DNS lookup timed out for ${hostname}`, 'ETIMEOUT'),
      signal,
      () => {
        const err = new Error('Request was canceled');
        err.name = 'AbortError';
        return err;
      }
    );

    if (addresses.length === 0) {
      throw createErrorWithCode(
        `No DNS results returned for ${hostname}`,
        'ENODATA'
      );
    }

    for (const addr of addresses) {
      if (addr.family !== 4 && addr.family !== 6) {
        throw createErrorWithCode(
          `Invalid address family returned for ${hostname}`,
          'EINVAL'
        );
      }
      if (this.ipBlocker.isBlockedIp(addr.address)) {
        throw createErrorWithCode(
          `Blocked IP detected for ${hostname}`,
          'EBLOCKED'
        );
      }
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
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
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

  if (!(error instanceof Error))
    return createUnknownFetchError(url, 'Unexpected error');

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

function withContextIds(fields: {
  contextRequestId?: string;
  operationId?: string;
}): Record<string, string> {
  const result: Record<string, string> = {};
  if (fields.contextRequestId)
    result.contextRequestId = fields.contextRequestId;
  if (fields.operationId) result.operationId = fields.operationId;
  return result;
}

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
      ...(contextRequestId ? { contextRequestId } : {}),
      ...(operationId ? { operationId } : {}),
    };

    this.publish({
      v: 1,
      type: 'start',
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...withContextIds(ctx),
    });

    this.logger.debug('HTTP Request', {
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      ...withContextIds(ctx),
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

    this.publish({
      v: 1,
      type: 'end',
      requestId: context.requestId,
      status: response.status,
      duration,
      ...withContextIds(context),
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
      ...withContextIds(context),
      ...(contentType ? { contentType } : {}),
      ...(size ? { size } : {}),
    });

    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      this.logger.warn('Slow HTTP request detected', {
        requestId: context.requestId,
        url: context.url,
        duration: durationLabel,
        ...withContextIds(context),
      });
    }
  }

  recordError(
    context: FetchTelemetryContext,
    error: unknown,
    status?: number
  ): void {
    const duration = performance.now() - context.startTime;
    const err = error instanceof Error ? error : new Error(String(error));
    const code = isSystemError(err) ? err.code : undefined;

    this.publish({
      v: 1,
      type: 'error',
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      duration,
      ...(code !== undefined ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      ...withContextIds(context),
    });

    if (status === 429) {
      this.logger.warn('HTTP Request Error', {
        requestId: context.requestId,
        url: context.url,
        status,
        code,
        error: err.message,
        ...withContextIds(context),
      });
      return;
    }

    this.logger.error('HTTP Request Error', {
      requestId: context.requestId,
      url: context.url,
      status,
      code,
      error: err.message,
      ...withContextIds(context),
    });
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

  cancelPromise.catch(() => undefined);
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
    if (!URL.canParse(location, baseUrl)) {
      throw createErrorWithCode('Invalid redirect target', 'EBADREDIRECT');
    }

    const resolved = new URL(location, baseUrl);
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

function isBinaryContent(buffer: Uint8Array): boolean {
  // Check for common binary magic numbers
  // PDF: %PDF
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return true;
  }

  // PNG: \x89PNG
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }

  // GIF: GIF8
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return true;
  }

  // JPEG: \xFF\xD8\xFF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return true;
  }

  // ZIP/JAR/APK: PK\x03\x04
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    return true;
  }

  // ELF: \x7fELF
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return true;
  }

  // Check for null bytes in the first 1000 bytes (heuristics)
  const checkLen = Math.min(buffer.length, 1000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0x00) {
      // Allow UTF-16 BOM? Naive check usually assumes UTF-8/Ascii for web.
      // But let's be safe: if we see nulls, it's likely binary.
      return true;
    }
  }

  return false;
}

class ResponseTextReader {
  async read(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{ text: string; size: number }> {
    if (signal?.aborted) {
      cancelResponseBody(response);
      throw createAbortedFetchError(url);
    }

    if (!response.body) {
      if (signal?.aborted) throw createCanceledFetchError(url);

      let buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        buffer = buffer.slice(0, maxBytes);
      }

      const uint8 = new Uint8Array(buffer);
      if (isBinaryContent(uint8)) {
        throw new FetchError(
          'Detailed content type check failed: binary content detected',
          url,
          500,
          { reason: 'binary_content_detected' }
        );
      }

      const decoder = createDecoder(encoding);
      const text = decoder.decode(buffer);
      return { text, size: buffer.byteLength };
    }

    return this.readStreamWithLimit(
      response.body,
      url,
      maxBytes,
      signal,
      encoding
    );
  }

  private async readNext(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    abortPromise: Promise<never> | null
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return abortPromise
      ? await Promise.race([reader.read(), abortPromise])
      : await reader.read();
  }

  private async readStreamWithLimit(
    stream: ReadableStream<Uint8Array>,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{ text: string; size: number }> {
    const decoder = createDecoder(encoding);
    const parts: string[] = [];
    let total = 0;

    const reader = stream.getReader();
    const abortRace = createAbortRace(signal, () =>
      createAbortedFetchError(url)
    );

    try {
      let result = await this.readNext(reader, abortRace.abortPromise);

      if (!result.done && isBinaryContent(result.value)) {
        await this.cancelReaderQuietly(reader);
        throw new FetchError(
          'Detailed content type check failed: binary content detected',
          url,
          500,
          { reason: 'binary_content_detected' }
        );
      }

      while (!result.done) {
        const { shouldBreak, newTotal } = this.processChunk(
          result.value,
          total,
          maxBytes,
          decoder,
          parts
        );
        total = newTotal;

        if (shouldBreak) {
          await this.cancelReaderQuietly(reader);
          break;
        }

        result = await this.readNext(reader, abortRace.abortPromise);
      }
    } catch (error: unknown) {
      await this.cancelReaderQuietly(reader);
      this.handleReadingError(error, url, signal);
    } finally {
      abortRace.cleanup();
      reader.releaseLock();
    }

    const final = decoder.decode();
    if (final) parts.push(final);

    return { text: parts.join(''), size: total };
  }

  private processChunk(
    chunk: Uint8Array,
    total: number,
    maxBytes: number,
    decoder: TextDecoder,
    parts: string[]
  ): { shouldBreak: boolean; newTotal: number } {
    const newTotal = total + chunk.byteLength;

    if (newTotal > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        const partial = chunk.subarray(0, remaining);
        const decoded = decoder.decode(partial, { stream: true });
        if (decoded) parts.push(decoded);
      }
      return { shouldBreak: true, newTotal: total + remaining };
    }

    const decoded = decoder.decode(chunk, { stream: true });
    if (decoded) parts.push(decoded);

    return { shouldBreak: false, newTotal };
  }

  private handleReadingError(
    error: unknown,
    url: string,
    signal?: AbortSignal
  ): never {
    if (error instanceof FetchError) throw error;
    if (signal?.aborted) throw createAbortedFetchError(url);
    throw error;
  }

  private async cancelReaderQuietly(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<void> {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup.
    }
  }
}

const DEFAULT_HEADERS = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate',
  Connection: 'keep-alive',
} as const satisfies Record<string, string>;

function buildHeaders(): Record<string, string> {
  return { ...DEFAULT_HEADERS };
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
  const [mediaType] = contentType.split(';', 1);
  const trimmed = mediaType?.trim();
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
  if (!mediaType) return;

  if (!isTextLikeMediaType(mediaType)) {
    throw new FetchError(`Unsupported content type: ${mediaType}`, url);
  }
}

async function handleFetchResponse(
  response: Response,
  finalUrl: string,
  ctx: FetchTelemetryContext,
  telemetry: FetchTelemetry,
  reader: ResponseTextReader,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const contentType = response.headers.get('content-type');
  assertSupportedContentType(contentType, finalUrl);
  const encoding = getCharsetFromContentType(contentType ?? null);

  const { text, size } = await reader.read(
    response,
    finalUrl,
    maxBytes,
    signal,
    encoding
  );
  telemetry.recordResponse(ctx, response, size);
  return text;
}

type FetcherConfig = typeof config.fetcher;

type HostnamePreflight = (url: string, signal?: AbortSignal) => Promise<void>;

function extractHostname(url: string): string {
  if (!URL.canParse(url)) {
    throw createErrorWithCode('Invalid URL', 'EINVAL');
  }
  return new URL(url).hostname;
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

      return await handleFetchResponse(
        response,
        finalUrl,
        ctx,
        this.telemetry,
        this.reader,
        this.fetcherConfig.maxContentLength,
        init.signal ?? undefined
      );
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
const dnsResolver = new SafeDnsResolver(ipBlocker);
const telemetry = new FetchTelemetry(
  defaultLogger,
  defaultContext,
  defaultRedactor
);
const normalizeRedirectUrl = (url: string): string =>
  urlNormalizer.validateAndNormalize(url);
const dnsPreflight = createDnsPreflight(dnsResolver);

// Legacy redirect follower (no per-hop DNS preflight).
const redirectFollower = new RedirectFollower(
  defaultFetch,
  normalizeRedirectUrl
);

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
  return redirectFollower.fetchWithRedirects(url, init, maxRedirects);
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
  encoding?: string
): Promise<{ text: string; size: number }> {
  return responseReader.read(response, url, maxBytes, signal, encoding);
}

export async function fetchNormalizedUrl(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<string> {
  return httpFetcher.fetchNormalizedUrl(normalizedUrl, options);
}
