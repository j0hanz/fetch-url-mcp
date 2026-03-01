import dns from 'node:dns';
import { BlockList, isIP, SocketAddress } from 'node:net';
import { domainToASCII } from 'node:url';

import { type config, logDebug } from './core.js';
import { createErrorWithCode, isError, isSystemError } from './utils.js';

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

export class SafeDnsResolver {
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
type HostnamePreflight = (url: string, signal?: AbortSignal) => Promise<string>;
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw createErrorWithCode('Invalid URL', 'EINVAL');
  }
}
export function createDnsPreflight(
  dnsResolver: SafeDnsResolver
): HostnamePreflight {
  return async (url: string, signal?: AbortSignal) => {
    const hostname = extractHostname(url);
    return await dnsResolver.resolveAndValidate(hostname, signal);
  };
}
export function normalizeHost(value: string): string | null {
  const trimmedLower = trimToNull(value)?.toLowerCase();
  if (!trimmedLower) return null;

  const first = takeFirstHostValue(trimmedLower);
  if (!first) return null;

  for (const resolveCandidate of [
    () => normalizeSocketAddress(first),
    () => parseHostWithUrl(first),
    () => normalizeBracketedIpv6(first),
  ]) {
    const candidate = resolveCandidate();
    if (candidate !== null) return candidate;
  }

  if (isIpV6Literal(first)) {
    return normalizeHostname(first);
  }

  return normalizeHostname(stripPortIfPresent(first));
}
function takeFirstHostValue(value: string): string | null {
  // Faster than split(',') for large forwarded headers; preserves behavior.
  const commaIndex = value.indexOf(',');
  const first = commaIndex === -1 ? value : value.slice(0, commaIndex);
  return first ? trimToNull(first) : null;
}
function stripIpv6Brackets(value: string): string | null {
  if (!value.startsWith('[')) return null;
  const end = value.indexOf(']');
  if (end === -1) return null;
  return value.slice(1, end);
}
function stripPortIfPresent(value: string): string {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) return value;
  return value.slice(0, colonIndex);
}
function isIpV6Literal(value: string): boolean {
  return isIP(value) === 6;
}
function normalizeSocketAddress(value: string): string | null {
  const socketAddress = SocketAddress.parse(value);
  if (!socketAddress) return null;
  return normalizeHostname(socketAddress.address);
}
function normalizeBracketedIpv6(value: string): string | null {
  const ipv6 = stripIpv6Brackets(value);
  if (!ipv6) return null;
  return normalizeHostname(ipv6);
}
function normalizeHostname(value: string): string | null {
  const trimmed = trimToNull(value)?.toLowerCase();
  if (!trimmed) return null;

  if (isIP(trimmed)) return stripTrailingDots(trimmed);

  const ascii = domainToASCII(trimmed);
  return ascii ? stripTrailingDots(ascii) : null;
}
function parseHostWithUrl(value: string): string | null {
  const candidateUrl = `http://${value}`;
  if (!URL.canParse(candidateUrl)) return null;

  try {
    const parsed = new URL(candidateUrl);
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}
function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
function stripTrailingDots(value: string): string {
  // Keep loop (rather than regex) to preserve exact behavior and avoid hidden allocations.
  let result = value;
  while (result.endsWith('.')) result = result.slice(0, -1);
  return result;
}
type IpFamily = 'ipv4' | 'ipv6';
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
const IPV6_MAPPED_PREFIX = '::ffff:';
type BlockedSubnet = Readonly<{
  subnet: string;
  prefix: number;
  family: IpFamily;
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
  { subnet: '::', prefix: 96, family: 'ipv6' },
];
export function createDefaultBlockList(): BlockList {
  const list = new BlockList();
  for (const entry of BLOCKED_SUBNETS) {
    list.addSubnet(entry.subnet, entry.prefix, entry.family);
  }
  return list;
}
function extractMappedIpv4(ip: string): string | null {
  if (!ip.startsWith(IPV6_MAPPED_PREFIX)) return null;
  const mapped = ip.slice(IPV6_MAPPED_PREFIX.length);
  return isIP(mapped) === 4 ? mapped : null;
}
function stripIpv6ZoneId(ip: string): string {
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex <= 0) return ip;
  return ip.slice(0, zoneIndex);
}
export function normalizeIpForBlockList(
  input: string
): { ip: string; family: IpFamily } | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  const normalizedInput = stripIpv6ZoneId(lowered);
  if (!normalizedInput) return null;

  const ipType = isIP(normalizedInput);
  switch (ipType) {
    case 4:
      return { ip: normalizedInput, family: 'ipv4' };
    case 6: {
      const mapped = extractMappedIpv4(normalizedInput);
      return mapped
        ? { ip: mapped, family: 'ipv4' }
        : { ip: normalizedInput, family: 'ipv6' };
    }
    default:
      return null;
  }
}
export interface TransformResult {
  readonly url: string;
  readonly transformed: boolean;
  readonly platform?: string;
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
export class RawUrlTransformer {
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
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';
function createValidationError(message: string): Error {
  return createErrorWithCode(message, VALIDATION_ERROR_CODE);
}
export const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];
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
function isLocalFetchAllowed(): boolean {
  return process.env['ALLOW_LOCAL_FETCH'] === 'true';
}
type SecurityConfig = typeof config.security;
export class IpBlocker {
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
type ConstantsConfig = typeof config.constants;
export class UrlNormalizer {
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
