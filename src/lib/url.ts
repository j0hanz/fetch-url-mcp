import dns from 'node:dns';
import { BlockList, isIP, SocketAddress } from 'node:net';
import { domainToASCII } from 'node:url';

import { config, logDebug } from './core.js';
import { VALIDATION_ERROR } from './error-codes.js';
import {
  blockedCnameError,
  blockedHostError,
  blockedIpError,
  dnsNoResultsError,
  dnsTimeoutError,
  invalidAddressFamilyError,
  invalidHostnameError,
  invalidUrlError,
} from './error-messages.js';
import { LOG_FETCH } from './logger-names.js';
import {
  CodedError,
  composeAbortSignal,
  isError,
  isSystemError,
} from './utils.js';

const DNS_LOOKUP_TIMEOUT_MS = 5000;
const CNAME_LOOKUP_MAX_DEPTH = 5;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  signal?: AbortSignal,
  onAbort?: () => Error
): Promise<T> {
  const raceSignal = composeAbortSignal(signal, timeoutMs);
  if (!raceSignal) return promise;

  const classifyError = (): Error =>
    signal?.aborted
      ? (onAbort?.() ?? new Error('Request was canceled'))
      : onTimeout();

  if (raceSignal.aborted) throw classifyError();

  const racePromise = new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      reject(classifyError());
    };
    raceSignal.addEventListener('abort', handleAbort, { once: true });

    promise.then(resolve, reject).finally(() => {
      raceSignal.removeEventListener('abort', handleAbort);
    });
  });
  return racePromise;
}
function createAbortSignalError(): Error {
  const err = new Error('Request was canceled');
  err.name = 'AbortError';
  return err;
}

export class SafeDnsResolver {
  private readonly cnameResolver = new dns.promises.Resolver({
    timeout: DNS_LOOKUP_TIMEOUT_MS,
    tries: 2,
  });

  constructor(
    private readonly ipBlocker: IpBlocker,
    private readonly security: SecurityConfig,
    private readonly blockedHostSuffixes: readonly string[]
  ) {}

  private assertIpAllowed(ip: string, context?: string): void {
    const result = this.ipBlocker.checkTarget(ip, []);
    if (!result) return;

    const errorTarget = context ?? ip;
    throw blockedIpError(
      errorTarget,
      result.reason === 'cloud-metadata' ? 'cloud-metadata' : 'private'
    );
  }

  async resolveAndValidate(
    hostname: string,
    signal?: AbortSignal
  ): Promise<string> {
    const normalizedHostname = normalizeHostname(
      hostname.replace(/^\[|\]$/g, '')
    );

    if (!normalizedHostname) {
      throw invalidHostnameError();
    }

    if (signal?.aborted) {
      throw createAbortSignalError();
    }

    if (this.isBlockedHostname(normalizedHostname)) {
      throw blockedHostError(normalizedHostname);
    }

    if (isIP(normalizedHostname)) {
      this.assertIpAllowed(normalizedHostname);
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
      () => dnsTimeoutError(normalizedHostname),
      signal,
      createAbortSignalError
    );

    if (addresses.length === 0 || !addresses[0]) {
      throw dnsNoResultsError(normalizedHostname);
    }

    for (const addr of addresses) {
      if (addr.family !== 4 && addr.family !== 6) {
        throw invalidAddressFamilyError(normalizedHostname);
      }
      this.assertIpAllowed(addr.address, normalizedHostname);
    }

    return addresses[0].address;
  }

  private isBlockedHostname(hostname: string): boolean {
    return this.ipBlocker.isHostBlocked(hostname, this.blockedHostSuffixes);
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
          throw blockedCnameError(hostname, cname);
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
      if (signal?.aborted) throw createAbortSignalError();
      const cnames = await this.cnameResolver.resolveCname(hostname);

      return cnames
        .map((value) => normalizeHostname(value))
        .filter((value): value is string => value !== null && value.length > 0);
    } catch (error) {
      if (isError(error) && error.name === 'AbortError') {
        throw error;
      }

      if (
        isSystemError(error) &&
        (error.code === 'ENODATA' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'ENODOMAIN' ||
          error.code === 'ETIMEOUT')
      ) {
        return [];
      }

      logDebug(
        'DNS CNAME lookup failed; continuing with address lookup',
        {
          hostname,
          ...(isSystemError(error) ? { code: error.code } : {}),
        },
        LOG_FETCH
      );
      return [];
    }
  }
}
type HostnamePreflight = (url: string, signal?: AbortSignal) => Promise<string>;
function extractHostname(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) throw invalidUrlError();
  return parsed.hostname;
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

  const socketAddr = SocketAddress.parse(first);
  if (socketAddr) return normalizeHostname(socketAddr.address);

  const parsed = URL.parse(`http://${first}`);
  if (parsed) return normalizeHostname(parsed.hostname);

  return normalizeHostname(first);
}
function takeFirstHostValue(value: string): string | null {
  // Faster than split(',') for large forwarded headers; preserves behavior.
  const commaIndex = value.indexOf(',');
  const first = commaIndex === -1 ? value : value.slice(0, commaIndex);
  return first ? trimToNull(first) : null;
}
function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
type IpFamily = 'ipv4' | 'ipv6';
type IpSegment = number | string;
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
  if (ip.startsWith(IPV6_MAPPED_PREFIX)) {
    const mapped = ip.slice(IPV6_MAPPED_PREFIX.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return null;
}

export function normalizeIpForBlockList(
  input: string
): { ip: string; family: IpFamily } | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;

  // Strip IPv6 zone ID (e.g. %eth0)
  const zoneIndex = lowered.indexOf('%');
  const normalizedInput = zoneIndex > 0 ? lowered.slice(0, zoneIndex) : lowered;
  if (!normalizedInput) return null;

  const ipType = isIP(normalizedInput);
  if (ipType === 4) return { ip: normalizedInput, family: 'ipv4' };
  if (ipType === 6) {
    const mappedIpv4 = extractMappedIpv4(normalizedInput);
    if (mappedIpv4) return { ip: mappedIpv4, family: 'ipv4' };
    return { ip: normalizedInput, family: 'ipv6' };
  }
  return null;
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

    const { base, hash, parsed } = this.resolveUrlStructure(url);

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

    const { base } = this.resolveUrlStructure(urlString);
    const lowerBase = base.toLowerCase();
    const lastDot = lowerBase.lastIndexOf('.');
    if (lastDot === -1) return false;
    return RAW_TEXT_EXTENSIONS.has(lowerBase.slice(lastDot));
  }

  private resolveUrlStructure(urlString: string): {
    base: string;
    hash: string;
    parsed?: URL;
  } {
    const parsed = URL.parse(urlString);
    if (parsed) {
      return {
        base: parsed.origin + parsed.pathname,
        hash: parsed.hash,
        parsed,
      };
    }
    return this.splitParams(urlString);
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
    const parsed = preParsed ?? URL.parse(base);
    if (!parsed) return null;

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;

    return (
      this.transformGithubGist(base, hash) ??
      this.transformGithubBlob(base) ??
      this.transformGitLab(base, parsed.origin) ??
      this.transformBitbucket(base, parsed.origin)
    );
  }

  private matchAndTransform(
    pattern: URLPattern,
    url: string,
    platform: string,
    transformFn: (groups: UrlPatternGroups) => string | null
  ): { url: string; platform: string } | null {
    const match = pattern.exec(url);
    if (!match) return null;
    const transformed = transformFn(match.pathname.groups as UrlPatternGroups);
    return transformed ? { url: transformed, platform } : null;
  }

  private transformGithubBlob(
    url: string
  ): { url: string; platform: string } | null {
    return this.matchAndTransform(
      GITHUB_BLOB_PATTERN,
      url,
      'github',
      (groups) => {
        const owner = getPatternGroup(groups, 'owner');
        const repo = getPatternGroup(groups, 'repo');
        const branch = getPatternGroup(groups, 'branch');
        const path = getPatternGroup(groups, 'path');
        if (!owner || !repo || !branch || !path) return null;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      }
    );
  }

  private transformGithubGist(
    url: string,
    hash: string
  ): { url: string; platform: string } | null {
    return this.transformRawGist(url) ?? this.transformStandardGist(url, hash);
  }

  private transformRawGist(
    url: string
  ): { url: string; platform: string } | null {
    return this.matchAndTransform(
      GITHUB_GIST_RAW_PATTERN,
      url,
      'github-gist',
      (groups) => {
        const user = getPatternGroup(groups, 'user');
        const gistId = getPatternGroup(groups, 'gistId');
        const rawFilePath = getPatternGroup(groups, 'filePath');
        if (!user || !gistId) return null;

        const resolvedFilePath = rawFilePath ? `/${rawFilePath}` : '';
        return `https://gist.githubusercontent.com/${user}/${gistId}/raw${resolvedFilePath}`;
      }
    );
  }

  private transformStandardGist(
    url: string,
    hash: string
  ): { url: string; platform: string } | null {
    return this.matchAndTransform(
      GITHUB_GIST_PATTERN,
      url,
      'github-gist',
      (groups) => {
        const user = getPatternGroup(groups, 'user');
        const gistId = getPatternGroup(groups, 'gistId');
        if (!user || !gistId) return null;

        let filePath = '';
        if (hash.startsWith('#file-')) {
          const filename = hash.slice('#file-'.length).replace(/-/g, '.');
          if (filename) filePath = `/${filename}`;
        }

        return `https://gist.githubusercontent.com/${user}/${gistId}/raw${filePath}`;
      }
    );
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
    return this.matchAndTransform(
      BITBUCKET_SRC_PATTERN,
      url,
      'bitbucket',
      (groups) => {
        const owner = getPatternGroup(groups, 'owner');
        const repo = getPatternGroup(groups, 'repo');
        const branch = getPatternGroup(groups, 'branch');
        const path = getPatternGroup(groups, 'path');
        if (!owner || !repo || !branch || !path) return null;
        return `${origin}/${owner}/${repo}/raw/${branch}/${path}`;
      }
    );
  }
}
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
export const VALIDATION_ERROR_CODE = VALIDATION_ERROR;
function createValidationError(message: string): Error {
  const error = new CodedError(message, VALIDATION_ERROR);
  return error;
}
export const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];
function isLocalFetchAllowed(): boolean {
  return config.security.allowLocalFetch;
}
type SecurityConfig = typeof config.security;
type BlockReason =
  | 'cloud-metadata'
  | 'blocked-host'
  | 'blocked-ip'
  | 'blocked-suffix';
type BlockCheckResult = Readonly<{ reason: BlockReason }>;
export class IpBlocker {
  private static readonly CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
    '169.254.169.254', // AWS / GCP / Azure
    'metadata.google.internal', // GCP
    '100.100.100.200', // Alibaba Cloud
    'fd00:ec2::254', // AWS IPv6
  ]);

  private readonly blockList = createDefaultBlockList();

  constructor(private readonly security: SecurityConfig) {}

  static isCloudMetadata(hostname: string): boolean {
    const lowered = hostname.toLowerCase();
    if (IpBlocker.CLOUD_METADATA_HOSTS.has(lowered)) return true;
    const normalized = normalizeIpForBlockList(lowered);
    return (
      normalized !== null && IpBlocker.CLOUD_METADATA_HOSTS.has(normalized.ip)
    );
  }

  checkTarget(
    target: string,
    suffixes: readonly string[]
  ): BlockCheckResult | null {
    if (IpBlocker.isCloudMetadata(target)) return { reason: 'cloud-metadata' };
    if (isLocalFetchAllowed()) return null;
    if (!target) return null;
    if (this.security.blockedHosts.has(target)) {
      return { reason: 'blocked-host' };
    }

    const normalizedIp = normalizeIpForBlockList(target);
    if (
      normalizedIp &&
      this.blockList.check(normalizedIp.ip, normalizedIp.family)
    ) {
      return { reason: 'blocked-ip' };
    }

    if (suffixes.some((suffix) => target.endsWith(suffix))) {
      return { reason: 'blocked-suffix' };
    }

    return null;
  }

  isBlockedIp(candidate: string): boolean {
    return this.checkTarget(candidate.trim().toLowerCase(), []) !== null;
  }

  isHostBlocked(
    hostname: string,
    blockedHostSuffixes: readonly string[]
  ): boolean {
    if (IpBlocker.isCloudMetadata(hostname)) return true;
    if (isLocalFetchAllowed()) return false;
    if (this.security.blockedHosts.has(hostname)) return true;
    return blockedHostSuffixes.some((suffix) => hostname.endsWith(suffix));
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
    const url = URL.parse(trimmedUrl);
    if (!url) {
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

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) {
      throw createValidationError('URL must have a valid hostname');
    }
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

  private assertHostnameAllowed(hostname: string): void {
    const result = this.ipBlocker.checkTarget(
      hostname,
      this.blockedHostSuffixes
    );
    if (!result) return;

    const messages: Record<BlockReason, string> = {
      'cloud-metadata': `Blocked host: ${hostname}. Cloud metadata endpoints are not allowed`,
      'blocked-host': `Blocked host: ${hostname}. Internal hosts are not allowed`,
      'blocked-ip': `Blocked IP range: ${hostname}. Private IPs are not allowed`,
      'blocked-suffix': `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`,
    };

    throw createValidationError(messages[result.reason]);
  }
}
export { isIP };

export function buildIpv4(
  parts: readonly [number, number, number, number]
): string {
  return parts.join('.');
}

export function stripTrailingDots(value: string): string {
  let result = value;
  while (result.endsWith('.')) result = result.slice(0, -1);
  return result;
}

export function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  if (isIP(lowered)) return stripTrailingDots(lowered);

  const ascii = domainToASCII(lowered);
  return ascii ? stripTrailingDots(ascii) : null;
}
