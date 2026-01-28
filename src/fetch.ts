import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import type { Dispatcher } from 'undici';
import { Agent } from 'undici';

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
import { isRecord } from './type-guards.js';

export interface FetchOptions {
  signal?: AbortSignal;
}

type IpSegment = number | string;

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function buildIpv6(parts: readonly IpSegment[]): string {
  return parts.map(String).join(':');
}

const BLOCK_LIST = new BlockList();

const IPV6_ZERO = buildIpv6([0, 0, 0, 0, 0, 0, 0, 0]);
const IPV6_LOOPBACK = buildIpv6([0, 0, 0, 0, 0, 0, 0, 1]);
const IPV6_64_FF9B = buildIpv6(['64', 'ff9b', 0, 0, 0, 0, 0, 0]);
const IPV6_64_FF9B_1 = buildIpv6(['64', 'ff9b', 1, 0, 0, 0, 0, 0]);
const IPV6_2001 = buildIpv6(['2001', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_2002 = buildIpv6(['2002', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FC00 = buildIpv6(['fc00', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FE80 = buildIpv6(['fe80', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FF00 = buildIpv6(['ff00', 0, 0, 0, 0, 0, 0, 0]);

const BLOCKED_IPV4_SUBNETS: readonly {
  subnet: string;
  prefix: number;
}[] = [
  { subnet: buildIpv4([0, 0, 0, 0]), prefix: 8 },
  { subnet: buildIpv4([10, 0, 0, 0]), prefix: 8 },
  { subnet: buildIpv4([100, 64, 0, 0]), prefix: 10 },
  { subnet: buildIpv4([127, 0, 0, 0]), prefix: 8 },
  { subnet: buildIpv4([169, 254, 0, 0]), prefix: 16 },
  { subnet: buildIpv4([172, 16, 0, 0]), prefix: 12 },
  { subnet: buildIpv4([192, 168, 0, 0]), prefix: 16 },
  { subnet: buildIpv4([224, 0, 0, 0]), prefix: 4 },
  { subnet: buildIpv4([240, 0, 0, 0]), prefix: 4 },
];
const BLOCKED_IPV6_SUBNETS: readonly {
  subnet: string;
  prefix: number;
}[] = [
  { subnet: IPV6_ZERO, prefix: 128 },
  { subnet: IPV6_LOOPBACK, prefix: 128 },
  { subnet: IPV6_64_FF9B, prefix: 96 },
  { subnet: IPV6_64_FF9B_1, prefix: 48 },
  { subnet: IPV6_2001, prefix: 32 },
  { subnet: IPV6_2002, prefix: 16 },
  { subnet: IPV6_FC00, prefix: 7 },
  { subnet: IPV6_FE80, prefix: 10 },
  { subnet: IPV6_FF00, prefix: 8 },
];

for (const entry of BLOCKED_IPV4_SUBNETS) {
  BLOCK_LIST.addSubnet(entry.subnet, entry.prefix, 'ipv4');
}
for (const entry of BLOCKED_IPV6_SUBNETS) {
  BLOCK_LIST.addSubnet(entry.subnet, entry.prefix, 'ipv6');
}

function matchesBlockedIpPatterns(resolvedIp: string): boolean {
  for (const pattern of config.security.blockedIpPatterns) {
    if (pattern.test(resolvedIp)) {
      return true;
    }
  }
  return false;
}

export function isBlockedIp(ip: string): boolean {
  if (config.security.blockedHosts.has(ip)) {
    return true;
  }
  const ipType = resolveIpType(ip);
  if (!ipType) return false;
  const normalizedIp = ip.toLowerCase();
  if (isBlockedByList(normalizedIp, ipType)) return true;
  return matchesBlockedIpPatterns(normalizedIp);
}

function resolveIpType(ip: string): 4 | 6 | null {
  const ipType = isIP(ip);
  return ipType === 4 || ipType === 6 ? ipType : null;
}

function isBlockedByList(ip: string, ipType: 4 | 6): boolean {
  if (ipType === 4) {
    return BLOCK_LIST.check(ip, 'ipv4');
  }
  return BLOCK_LIST.check(ip, 'ipv6');
}

export function normalizeUrl(urlString: string): {
  normalizedUrl: string;
  hostname: string;
} {
  const trimmedUrl = requireTrimmedUrl(urlString);
  assertUrlLength(trimmedUrl);

  const url = parseUrl(trimmedUrl);
  assertHttpProtocol(url);
  assertNoCredentials(url);

  const hostname = normalizeHostname(url);
  assertHostnameAllowed(hostname);

  // Canonicalize hostname to avoid trailing-dot variants and keep url.href consistent.
  url.hostname = hostname;

  return { normalizedUrl: url.href, hostname };
}

export function validateAndNormalizeUrl(urlString: string): string {
  return normalizeUrl(urlString).normalizedUrl;
}

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

function createValidationError(message: string): Error {
  return createErrorWithCode(message, VALIDATION_ERROR_CODE);
}

function requireTrimmedUrl(urlString: string): string {
  if (!urlString || typeof urlString !== 'string') {
    throw createValidationError('URL is required');
  }

  const trimmedUrl = urlString.trim();
  if (!trimmedUrl) {
    throw createValidationError('URL cannot be empty');
  }

  return trimmedUrl;
}

function assertUrlLength(url: string): void {
  if (url.length <= config.constants.maxUrlLength) return;
  throw createValidationError(
    `URL exceeds maximum length of ${config.constants.maxUrlLength} characters`
  );
}

function parseUrl(urlString: string): URL {
  if (!URL.canParse(urlString)) {
    throw createValidationError('Invalid URL format');
  }
  return new URL(urlString);
}

function assertHttpProtocol(url: URL): void {
  if (url.protocol === 'http:' || url.protocol === 'https:') return;
  throw createValidationError(
    `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`
  );
}

function assertNoCredentials(url: URL): void {
  if (!url.username && !url.password) return;
  throw createValidationError('URLs with embedded credentials are not allowed');
}

function normalizeHostname(url: URL): string {
  let hostname = url.hostname.toLowerCase();
  while (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  if (!hostname) {
    throw createValidationError('URL must have a valid hostname');
  }
  return hostname;
}

const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];

function assertHostnameAllowed(hostname: string): void {
  assertNotBlockedHost(hostname);
  assertNotBlockedIp(hostname);
  assertNotBlockedHostnameSuffix(hostname);
}

function assertNotBlockedHost(hostname: string): void {
  if (!config.security.blockedHosts.has(hostname)) return;
  throw createValidationError(
    `Blocked host: ${hostname}. Internal hosts are not allowed`
  );
}

function assertNotBlockedIp(hostname: string): void {
  if (!isBlockedIp(hostname)) return;
  throw createValidationError(
    `Blocked IP range: ${hostname}. Private IPs are not allowed`
  );
}

function assertNotBlockedHostnameSuffix(hostname: string): void {
  if (!matchesBlockedSuffix(hostname)) return;
  throw createValidationError(
    `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`
  );
}

function matchesBlockedSuffix(hostname: string): boolean {
  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export interface TransformResult {
  readonly url: string;
  readonly transformed: boolean;
  readonly platform?: string;
}

interface TransformRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly transform: (match: RegExpExecArray) => string;
}

const GITHUB_BLOB_RULE: TransformRule = {
  name: 'github',
  pattern:
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i,
  transform: (match) => {
    const owner = match[1] ?? '';
    const repo = match[2] ?? '';
    const branch = match[3] ?? '';
    const path = match[4] ?? '';
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  },
};

const GITHUB_GIST_RULE: TransformRule = {
  name: 'github-gist',
  pattern:
    /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)(?:#file-(.+)|\/raw\/([^/]+))?$/i,
  transform: (match) => {
    const user = match[1] ?? '';
    const gistId = match[2] ?? '';
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
    const baseUrl = match[1] ?? '';
    const branch = match[2] ?? '';
    const path = match[3] ?? '';
    return `${baseUrl}/-/raw/${branch}/${path}`;
  },
};

const BITBUCKET_SRC_RULE: TransformRule = {
  name: 'bitbucket',
  pattern:
    /^(https?:\/\/(?:www\.)?bitbucket\.org\/[^/]+\/[^/]+)\/src\/([^/]+)\/(.+)$/i,
  transform: (match) => {
    const baseUrl = match[1] ?? '';
    const branch = match[2] ?? '';
    const path = match[3] ?? '';
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

function isRawUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('raw.githubusercontent.com') ||
    lowerUrl.includes('gist.githubusercontent.com') ||
    lowerUrl.includes('/-/raw/') ||
    BITBUCKET_RAW_RE.test(lowerUrl)
  );
}

function getUrlWithoutParams(url: string): {
  base: string;
  hash: string;
} {
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  let endIndex = url.length;
  if (queryIndex !== -1) {
    if (hashIndex !== -1) {
      endIndex = Math.min(queryIndex, hashIndex);
    } else {
      endIndex = queryIndex;
    }
  } else if (hashIndex !== -1) {
    endIndex = hashIndex;
  }

  const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';

  return {
    base: url.slice(0, endIndex),
    hash,
  };
}

function resolveUrlToMatch(
  rule: TransformRule,
  base: string,
  hash: string
): string {
  if (rule.name !== 'github-gist') return base;
  if (!hash.startsWith('#file-')) return base;
  return base + hash;
}

function applyTransformRules(
  base: string,
  hash: string
): { url: string; platform: string } | null {
  for (const rule of TRANSFORM_RULES) {
    const urlToMatch = resolveUrlToMatch(rule, base, hash);

    const match = rule.pattern.exec(urlToMatch);
    if (match) {
      return { url: rule.transform(match), platform: rule.name };
    }
  }

  return null;
}

export function transformToRawUrl(url: string): TransformResult {
  if (!url) return { url, transformed: false };
  if (isRawUrl(url)) {
    return { url, transformed: false };
  }

  const { base, hash } = getUrlWithoutParams(url);
  const result = applyTransformRules(base, hash);
  if (!result) return { url, transformed: false };

  logDebug('URL transformed to raw content URL', {
    platform: result.platform,
    original: url.substring(0, 100),
    transformed: result.url.substring(0, 100),
  });
  return {
    url: result.url,
    transformed: true,
    platform: result.platform,
  };
}

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

export function isRawTextContentUrl(url: string): boolean {
  if (!url) return false;
  if (isRawUrl(url)) return true;

  const { base } = getUrlWithoutParams(url);
  const lowerBase = base.toLowerCase();

  return hasKnownRawTextExtension(lowerBase);
}

function hasKnownRawTextExtension(urlBaseLower: string): boolean {
  for (const ext of RAW_TEXT_EXTENSIONS) {
    if (urlBaseLower.endsWith(ext)) return true;
  }
  return false;
}

const DNS_LOOKUP_TIMEOUT_MS = 5000;

function normalizeLookupResults(
  addresses: string | dns.LookupAddress[],
  family: number | undefined
): dns.LookupAddress[] {
  if (Array.isArray(addresses)) {
    return addresses;
  }

  return [{ address: addresses, family: family ?? 4 }];
}

function findBlockedIpError(
  list: dns.LookupAddress[],
  hostname: string
): NodeJS.ErrnoException | null {
  for (const addr of list) {
    const ip = typeof addr === 'string' ? addr : addr.address;
    if (!isBlockedIp(ip)) {
      continue;
    }

    return createErrorWithCode(
      `Blocked IP detected for ${hostname}`,
      'EBLOCKED'
    );
  }

  return null;
}

function findInvalidFamilyError(
  list: dns.LookupAddress[],
  hostname: string
): NodeJS.ErrnoException | null {
  for (const addr of list) {
    const family = typeof addr === 'string' ? 0 : addr.family;
    if (family === 4 || family === 6) continue;
    return createErrorWithCode(
      `Invalid address family returned for ${hostname}`,
      'EINVAL'
    );
  }

  return null;
}

function createNoDnsResultsError(hostname: string): NodeJS.ErrnoException {
  return createErrorWithCode(
    `No DNS results returned for ${hostname}`,
    'ENODATA'
  );
}

function createEmptySelection(hostname: string): {
  address: string | dns.LookupAddress[];
  family?: number;
  error?: NodeJS.ErrnoException;
  fallback: dns.LookupAddress[];
} {
  return {
    error: createNoDnsResultsError(hostname),
    fallback: [],
    address: [],
  };
}

function selectLookupResult(
  list: dns.LookupAddress[],
  useAll: boolean,
  hostname: string
): {
  address: string | dns.LookupAddress[];
  family?: number;
  error?: NodeJS.ErrnoException;
  fallback: dns.LookupAddress[];
} {
  if (list.length === 0) return createEmptySelection(hostname);

  if (useAll) return { address: list, fallback: list };

  const first = list.at(0);
  if (!first) return createEmptySelection(hostname);

  return {
    address: first.address,
    family: first.family,
    fallback: list,
  };
}

function findLookupError(
  list: dns.LookupAddress[],
  hostname: string
): NodeJS.ErrnoException | null {
  return (
    findInvalidFamilyError(list, hostname) ?? findBlockedIpError(list, hostname)
  );
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

function normalizeAndValidateLookupResults(
  addresses: string | dns.LookupAddress[],
  resolvedFamily: number | undefined,
  hostname: string
): { list: dns.LookupAddress[]; error: NodeJS.ErrnoException | null } {
  const list = normalizeLookupResults(addresses, resolvedFamily);
  const error = findLookupError(list, hostname);
  return { list, error };
}

function respondLookupError(
  callback: LookupCallback,
  error: NodeJS.ErrnoException,
  addresses: string | dns.LookupAddress[]
): void {
  callback(error, addresses);
}

function respondLookupSelection(
  callback: LookupCallback,
  selection: ReturnType<typeof selectLookupResult>
): void {
  if (selection.error) {
    callback(selection.error, selection.fallback);
    return;
  }
  callback(null, selection.address, selection.family);
}

function handleLookupResult(
  error: NodeJS.ErrnoException | null,
  addresses: string | dns.LookupAddress[],
  hostname: string,
  resolvedFamily: number | undefined,
  useAll: boolean,
  callback: LookupCallback
): void {
  if (error) {
    respondLookupError(callback, error, addresses);
    return;
  }

  const { list, error: lookupError } = normalizeAndValidateLookupResults(
    addresses,
    resolvedFamily,
    hostname
  );
  if (lookupError) {
    respondLookupError(callback, lookupError, list);
    return;
  }

  respondLookupSelection(callback, selectLookupResult(list, useAll, hostname));
}

function resolveDns(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void {
  const { normalizedOptions, useAll, resolvedFamily } =
    buildLookupContext(options);
  const lookupOptions = buildLookupOptions(normalizedOptions);

  const timeout = createLookupTimeout(hostname, callback);
  const safeCallback = wrapLookupCallback(callback, timeout);

  dns.lookup(
    hostname,
    lookupOptions,
    createLookupCallback(hostname, resolvedFamily, useAll, safeCallback)
  );
}

function normalizeLookupOptions(
  options: dns.LookupOptions | number
): dns.LookupOptions {
  return typeof options === 'number' ? { family: options } : options;
}

function buildLookupContext(options: dns.LookupOptions | number): {
  normalizedOptions: dns.LookupOptions;
  useAll: boolean;
  resolvedFamily: number | undefined;
} {
  const normalizedOptions = normalizeLookupOptions(options);
  return {
    normalizedOptions,
    useAll: Boolean(normalizedOptions.all),
    resolvedFamily: resolveFamily(normalizedOptions.family),
  };
}

const DEFAULT_DNS_ORDER: dns.LookupOptions['order'] = 'verbatim';

function resolveResultOrder(
  options: dns.LookupOptions
): dns.LookupOptions['order'] {
  if (options.order) return options.order;
  const legacyVerbatim = getLegacyVerbatim(options);
  if (legacyVerbatim !== undefined) {
    return legacyVerbatim ? 'verbatim' : 'ipv4first';
  }
  return DEFAULT_DNS_ORDER;
}

function getLegacyVerbatim(options: dns.LookupOptions): boolean | undefined {
  if (isRecord(options)) {
    const { verbatim } = options;
    return typeof verbatim === 'boolean' ? verbatim : undefined;
  }
  return undefined;
}

function buildLookupOptions(
  normalizedOptions: dns.LookupOptions
): dns.LookupOptions {
  return {
    family: normalizedOptions.family,
    hints: normalizedOptions.hints,
    all: true,
    order: resolveResultOrder(normalizedOptions),
  };
}

function createLookupCallback(
  hostname: string,
  resolvedFamily: number | undefined,
  useAll: boolean,
  callback: LookupCallback
): (
  err: NodeJS.ErrnoException | null,
  addresses: string | dns.LookupAddress[]
) => void {
  return (err, addresses) => {
    handleLookupResult(
      err,
      addresses,
      hostname,
      resolvedFamily,
      useAll,
      callback
    );
  };
}

function resolveFamily(
  family: dns.LookupOptions['family']
): number | undefined {
  if (family === 'IPv4') return 4;
  if (family === 'IPv6') return 6;
  return family;
}

function createLookupTimeout(
  hostname: string,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): {
  isDone: () => boolean;
  markDone: () => void;
} {
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    callback(
      createErrorWithCode(`DNS lookup timed out for ${hostname}`, 'ETIMEOUT'),
      []
    );
  }, DNS_LOOKUP_TIMEOUT_MS);
  timer.unref();

  return {
    isDone: (): boolean => done,
    markDone: (): void => {
      done = true;
      clearTimeout(timer);
    },
  };
}

function wrapLookupCallback(
  callback: LookupCallback,
  timeout: {
    isDone: () => boolean;
    markDone: () => void;
  }
): LookupCallback {
  return (err, address, family): void => {
    if (timeout.isDone()) return;
    timeout.markDone();
    callback(err, address, family);
  };
}

function getAgentOptions(): ConstructorParameters<typeof Agent>[0] {
  const cpuCount = os.availableParallelism();
  return {
    keepAliveTimeout: 60000,
    connections: Math.max(cpuCount * 2, 25),
    pipelining: 1,
    connect: { lookup: resolveDns },
  };
}

export const dispatcher: Dispatcher = new Agent(getAgentOptions());

export function destroyAgents(): void {
  void dispatcher.close();
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 60;
  const parsed = parseInt(header, 10);
  return Number.isNaN(parsed) ? 60 : parsed;
}

function createCanceledError(url: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
  });
}

function createTimeoutError(url: string, timeoutMs: number): FetchError {
  return new FetchError(`Request timeout after ${timeoutMs}ms`, url, 504, {
    timeout: timeoutMs,
  });
}

function createRateLimitError(
  url: string,
  headerValue: string | null
): FetchError {
  const retryAfter = parseRetryAfter(headerValue);
  return new FetchError('Too many requests', url, 429, { retryAfter });
}

function createHttpError(
  url: string,
  status: number,
  statusText: string
): FetchError {
  return new FetchError(`HTTP ${status}: ${statusText}`, url, status);
}

function createSizeLimitError(url: string, maxBytes: number): FetchError {
  return new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

function createNetworkError(url: string, message?: string): FetchError {
  const details = message ? { message } : undefined;
  return new FetchError(
    `Network error: Could not reach ${url}`,
    url,
    undefined,
    details ?? {}
  );
}

function createUnknownError(url: string, message: string): FetchError {
  return new FetchError(message, url);
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

function getRequestUrl(record: Record<string, unknown>): string | null {
  const value = record.requestUrl;
  return typeof value === 'string' ? value : null;
}

function resolveErrorUrl(error: unknown, fallback: string): string {
  if (error instanceof FetchError) return error.url;
  if (!isRecord(error)) return fallback;
  const requestUrl = getRequestUrl(error);
  if (requestUrl) return requestUrl;
  return fallback;
}

function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error)) {
    if (isTimeoutError(error)) {
      return createTimeoutError(url, timeoutMs);
    }
    return createCanceledError(url);
  }

  if (error instanceof Error) {
    return createNetworkError(url, error.message);
  }

  return createUnknownError(url, 'Unexpected error');
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

function publishFetchEvent(event: FetchChannelEvent): void {
  if (!fetchChannel.hasSubscribers) return;
  try {
    fetchChannel.publish(event);
  } catch {
    // Avoid crashing the publisher if a subscriber throws.
  }
}

interface FetchTelemetryContext {
  requestId: string;
  startTime: number;
  url: string;
  method: string;
  contextRequestId?: string;
  operationId?: string;
}

type FetchContextFields = Pick<
  FetchTelemetryContext,
  'contextRequestId' | 'operationId'
>;

function buildContextFields(
  context: FetchContextFields
): Partial<FetchContextFields> {
  const fields: Partial<FetchContextFields> = {};
  if (context.contextRequestId) {
    fields.contextRequestId = context.contextRequestId;
  }
  if (context.operationId) {
    fields.operationId = context.operationId;
  }
  return fields;
}

function buildResponseMetadata(
  response: Response,
  contentSize?: number
): {
  contentType?: string;
  size?: string;
} {
  const contentType = response.headers.get('content-type') ?? undefined;
  const contentLengthHeader = response.headers.get('content-length');
  const size =
    contentLengthHeader ??
    (contentSize === undefined ? undefined : String(contentSize));

  const metadata: { contentType?: string; size?: string } = {};
  if (contentType) metadata.contentType = contentType;
  if (size) metadata.size = size;
  return metadata;
}

function logSlowRequest(
  context: FetchTelemetryContext,
  duration: number,
  durationLabel: string,
  contextFields: Partial<FetchContextFields>
): void {
  if (duration <= 5000) return;
  logWarn('Slow HTTP request detected', {
    requestId: context.requestId,
    url: context.url,
    duration: durationLabel,
    ...contextFields,
  });
}

function resolveSystemErrorCode(error: Error): string | undefined {
  return isSystemError(error) ? error.code : undefined;
}

function buildFetchErrorEvent(
  context: FetchTelemetryContext,
  err: Error,
  duration: number,
  contextFields: Partial<FetchContextFields>,
  status?: number,
  code?: string
): FetchChannelEvent {
  const event: FetchChannelEvent = {
    v: 1,
    type: 'error',
    requestId: context.requestId,
    url: context.url,
    error: err.message,
    duration,
    ...contextFields,
  };

  if (code !== undefined) {
    event.code = code;
  }
  if (status !== undefined) {
    event.status = status;
  }

  return event;
}

function createTelemetryContext(
  url: string,
  method: string
): FetchTelemetryContext {
  const safeUrl = redactUrl(url);
  const contextRequestId = getRequestId();
  const operationId = getOperationId();
  return {
    requestId: randomUUID(),
    startTime: performance.now(),
    url: safeUrl,
    method: method.toUpperCase(),
    ...(contextRequestId ? { contextRequestId } : {}),
    ...(operationId ? { operationId } : {}),
  };
}

export function startFetchTelemetry(
  url: string,
  method: string
): FetchTelemetryContext {
  const context = createTelemetryContext(url, method);
  const contextFields = buildContextFields(context);

  publishFetchEvent({
    v: 1,
    type: 'start',
    requestId: context.requestId,
    method: context.method,
    url: context.url,
    ...contextFields,
  });

  logDebug('HTTP Request', {
    requestId: context.requestId,
    method: context.method,
    url: context.url,
    ...contextFields,
  });

  return context;
}

export function recordFetchResponse(
  context: FetchTelemetryContext,
  response: Response,
  contentSize?: number
): void {
  const duration = performance.now() - context.startTime;
  const durationLabel = `${Math.round(duration)}ms`;
  const contextFields = buildContextFields(context);
  const responseMetadata = buildResponseMetadata(response, contentSize);
  publishFetchEvent({
    v: 1,
    type: 'end',
    requestId: context.requestId,
    status: response.status,
    duration,
    ...contextFields,
  });

  logDebug('HTTP Response', {
    requestId: context.requestId,
    status: response.status,
    url: context.url,
    duration: durationLabel,
    ...contextFields,
    ...responseMetadata,
  });

  logSlowRequest(context, duration, durationLabel, contextFields);
}

export function recordFetchError(
  context: FetchTelemetryContext,
  error: unknown,
  status?: number
): void {
  const duration = performance.now() - context.startTime;
  const err = error instanceof Error ? error : new Error(String(error));
  const contextFields = buildContextFields(context);
  const code = resolveSystemErrorCode(err);
  publishFetchEvent(
    buildFetchErrorEvent(context, err, duration, contextFields, status, code)
  );

  const log = status === 429 ? logWarn : logError;
  log('HTTP Request Error', {
    requestId: context.requestId,
    url: context.url,
    status,
    code,
    error: err.message,
    ...contextFields,
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function cancelResponseBody(response: Response): void {
  const cancelPromise = response.body?.cancel();
  if (cancelPromise) {
    cancelPromise.catch(() => {
      // Best-effort cancellation; ignore failures.
    });
  }
}

interface FetchCycleResult {
  response: Response;
  nextUrl?: string;
}

async function performFetchCycle(
  currentUrl: string,
  init: RequestInit,
  redirectLimit: number,
  redirectCount: number
): Promise<FetchCycleResult> {
  const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

  if (!isRedirectStatus(response.status)) {
    return { response };
  }

  assertRedirectWithinLimit(response, currentUrl, redirectLimit, redirectCount);
  const location = getRedirectLocation(response, currentUrl);

  cancelResponseBody(response);
  return {
    response,
    nextUrl: resolveRedirectTarget(currentUrl, location),
  };
}

function assertRedirectWithinLimit(
  response: Response,
  currentUrl: string,
  redirectLimit: number,
  redirectCount: number
): void {
  if (redirectCount < redirectLimit) return;
  cancelResponseBody(response);
  throw new FetchError('Too many redirects', currentUrl);
}

function getRedirectLocation(response: Response, currentUrl: string): string {
  const location = response.headers.get('location');
  if (location) return location;

  cancelResponseBody(response);
  throw new FetchError('Redirect response missing Location header', currentUrl);
}

function annotateRedirectError(error: unknown, url: string): void {
  if (!isRecord(error)) return;
  error.requestUrl = url;
}

function resolveRedirectTarget(baseUrl: string, location: string): string {
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

  return validateAndNormalizeUrl(resolved.href);
}

export async function fetchWithRedirects(
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
    const { response, nextUrl } = await performFetchCycleSafely(
      currentUrl,
      init,
      redirectLimit,
      redirectCount
    );

    if (!nextUrl) {
      return { response, url: currentUrl };
    }

    currentUrl = nextUrl;
  }

  throw new FetchError('Too many redirects', currentUrl);
}

async function performFetchCycleSafely(
  currentUrl: string,
  init: RequestInit,
  redirectLimit: number,
  redirectCount: number
): Promise<FetchCycleResult> {
  try {
    return await performFetchCycle(
      currentUrl,
      init,
      redirectLimit,
      redirectCount
    );
  } catch (error: unknown) {
    annotateRedirectError(error, currentUrl);
    throw error;
  }
}

function assertContentLengthWithinLimit(
  response: Response,
  url: string,
  maxBytes: number
): void {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) return;
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (Number.isNaN(contentLength) || contentLength <= maxBytes) {
    return;
  }

  cancelResponseBody(response);

  throw createSizeLimitError(url, maxBytes);
}

interface StreamReadState {
  decoder: TextDecoder;
  parts: string[];
  total: number;
}

function createReadState(): StreamReadState {
  return {
    decoder: new TextDecoder(),
    parts: [],
    total: 0,
  };
}

function appendChunk(
  state: StreamReadState,
  chunk: Uint8Array,
  maxBytes: number,
  url: string
): void {
  state.total += chunk.byteLength;
  if (state.total > maxBytes) {
    throw createSizeLimitError(url, maxBytes);
  }

  const decoded = state.decoder.decode(chunk, { stream: true });
  if (decoded) state.parts.push(decoded);
}

function finalizeRead(state: StreamReadState): void {
  const decoded = state.decoder.decode();
  if (decoded) state.parts.push(decoded);
}

function createAbortError(url: string): FetchError {
  return new FetchError('Request was aborted during response read', url, 499, {
    reason: 'aborted',
  });
}

async function cancelReaderQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancel errors; we're already failing this read.
  }
}

async function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  if (!signal?.aborted) return;
  await cancelReaderQuietly(reader);
  throw createAbortError(url);
}

async function handleReadFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  url: string,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<never> {
  const aborted = signal?.aborted ?? false;
  await cancelReaderQuietly(reader);
  if (aborted) {
    throw createAbortError(url);
  }
  throw error;
}

async function readAllChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StreamReadState,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<void> {
  await throwIfAborted(signal, url, reader);

  let result = await reader.read();
  while (!result.done) {
    appendChunk(state, result.value, maxBytes, url);
    await throwIfAborted(signal, url, reader);
    result = await reader.read();
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  const state = createReadState();
  const reader = stream.getReader();

  try {
    await readAllChunks(reader, state, url, maxBytes, signal);
  } catch (error: unknown) {
    await handleReadFailure(error, signal, url, reader);
  } finally {
    reader.releaseLock();
  }

  finalizeRead(state);
  return { text: state.parts.join(''), size: state.total };
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  assertContentLengthWithinLimit(response, url, maxBytes);

  if (!response.body) {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    if (size > maxBytes) {
      throw createSizeLimitError(url, maxBytes);
    }
    return { text, size };
  }

  return readStreamWithLimit(response.body, url, maxBytes, signal);
}

const DEFAULT_HEADERS = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
} as const satisfies Record<string, string>;

function buildHeaders(): Record<string, string> {
  return { ...DEFAULT_HEADERS };
}

function buildRequestSignal(
  timeoutMs: number,
  external?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  return AbortSignal.any([external, timeoutSignal]);
}

function buildRequestInit(
  headers: HeadersInit,
  signal: AbortSignal
): RequestInit & { dispatcher: Dispatcher } {
  return {
    method: 'GET',
    headers,
    signal,
    dispatcher,
  };
}

function resolveResponseError(
  response: Response,
  finalUrl: string
): FetchError | null {
  return (
    resolveRateLimitError(response, finalUrl) ??
    resolveHttpError(response, finalUrl)
  );
}

function resolveRateLimitError(
  response: Response,
  finalUrl: string
): FetchError | null {
  return response.status === 429
    ? createRateLimitError(finalUrl, response.headers.get('retry-after'))
    : null;
}

function resolveHttpError(
  response: Response,
  finalUrl: string
): FetchError | null {
  return response.ok
    ? null
    : createHttpError(finalUrl, response.status, response.statusText);
}

async function handleFetchResponse(
  response: Response,
  finalUrl: string,
  telemetry: FetchTelemetryContext,
  signal?: AbortSignal
): Promise<string> {
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const { text, size } = await readResponseText(
    response,
    finalUrl,
    config.fetcher.maxContentLength,
    signal
  );
  recordFetchResponse(telemetry, response, size);
  return text;
}

async function fetchWithTelemetry(
  normalizedUrl: string,
  requestInit: RequestInit,
  timeoutMs: number
): Promise<string> {
  const telemetry = startFetchTelemetry(normalizedUrl, 'GET');

  try {
    return await fetchAndHandle(normalizedUrl, requestInit, telemetry);
  } catch (error: unknown) {
    const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
    telemetry.url = mapped.url;
    recordFetchError(telemetry, mapped, mapped.statusCode);
    throw mapped;
  }
}

async function fetchAndHandle(
  normalizedUrl: string,
  requestInit: RequestInit,
  telemetry: FetchTelemetryContext
): Promise<string> {
  const { response, url: finalUrl } = await fetchWithRedirects(
    normalizedUrl,
    requestInit,
    config.fetcher.maxRedirects
  );

  telemetry.url = finalUrl;
  return handleFetchResponse(
    response,
    finalUrl,
    telemetry,
    requestInit.signal ?? undefined
  );
}

export async function fetchNormalizedUrl(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<string> {
  const timeoutMs = config.fetcher.timeout;
  const headers = buildHeaders();
  const signal = buildRequestSignal(timeoutMs, options?.signal);
  const requestInit = buildRequestInit(headers, signal);
  return fetchWithTelemetry(normalizedUrl, requestInit, timeoutMs);
}
