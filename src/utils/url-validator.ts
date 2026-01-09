import { BlockList, isIP } from 'node:net';

import { config } from '../config/index.js';

import { createErrorWithCode } from './error-utils.js';
import { buildIpv4, buildIpv6 } from './ip-address.js';

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
  try {
    return new URL(urlString);
  } catch {
    throw createValidationError('Invalid URL format');
  }
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
  const hostname = url.hostname.toLowerCase();
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
