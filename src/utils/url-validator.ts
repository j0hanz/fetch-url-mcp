import ipaddr from 'ipaddr.js';

import { config } from '../config/index.js';

const BLOCKED_IPV4_RANGES = new Set([
  'private',
  'loopback',
  'linkLocal',
  'multicast',
  'broadcast',
  'reserved',
  'unspecified',
  'carrierGradeNat',
]);

const BLOCKED_IPV6_RANGES = new Set([
  'uniqueLocal',
  'linkLocal',
  'loopback',
  'multicast',
  'reserved',
  'unspecified',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
]);

type IpAddress = ipaddr.IPv4 | ipaddr.IPv6;

function isBlockedIpv4Range(range: string): boolean {
  return BLOCKED_IPV4_RANGES.has(range);
}

function isBlockedIpv6Range(range: string): boolean {
  return BLOCKED_IPV6_RANGES.has(range);
}

function isIpv6Address(addr: IpAddress): addr is ipaddr.IPv6 {
  return addr.kind() === 'ipv6';
}

function parseIp(ip: string): IpAddress | null {
  if (!ipaddr.isValid(ip)) {
    return null;
  }
  return ipaddr.parse(ip) as IpAddress;
}

function matchesBlockedIpPatterns(resolvedIp: string): boolean {
  for (const pattern of config.security.blockedIpPatterns) {
    if (pattern.test(resolvedIp)) {
      return true;
    }
  }
  return false;
}

function isBlockedIpv4Address(addr: ipaddr.IPv4): boolean {
  return (
    isBlockedIpv4Range(addr.range()) ||
    matchesBlockedIpPatterns(addr.toString())
  );
}

function isBlockedIpv6Address(addr: ipaddr.IPv6): boolean {
  if (addr.isIPv4MappedAddress()) {
    const ipv4 = addr.toIPv4Address();
    return isBlockedIpv4Address(ipv4);
  }

  return (
    isBlockedIpv6Range(addr.range()) ||
    matchesBlockedIpPatterns(addr.toNormalizedString())
  );
}

export function isBlockedIp(ip: string): boolean {
  if (config.security.blockedHosts.has(ip)) {
    return true;
  }

  const addr = parseIp(ip);
  if (!addr) {
    return false;
  }

  return isIpv6Address(addr)
    ? isBlockedIpv6Address(addr)
    : isBlockedIpv4Address(addr);
}

function assertUrlProvided(urlString: string): void {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required');
  }
}

function assertUrlNotEmpty(trimmedUrl: string): void {
  if (!trimmedUrl) {
    throw new Error('URL cannot be empty');
  }
}

function assertUrlLength(trimmedUrl: string): void {
  if (trimmedUrl.length > config.constants.maxUrlLength) {
    throw new Error(
      `URL exceeds maximum length of ${config.constants.maxUrlLength} characters`
    );
  }
}

function parseUrl(trimmedUrl: string): URL {
  try {
    return new URL(trimmedUrl);
  } catch {
    throw new Error('Invalid URL format');
  }
}

function assertProtocolAllowed(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`
    );
  }
}

function assertNoCredentials(url: URL): void {
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
}

function assertHostnamePresent(hostname: string): void {
  if (!hostname) {
    throw new Error('URL must have a valid hostname');
  }
}

function assertHostnameAllowed(hostname: string): void {
  if (config.security.blockedHosts.has(hostname)) {
    throw new Error(
      `Blocked host: ${hostname}. Internal hosts are not allowed`
    );
  }
}

function assertHostnameNotIpBlocked(hostname: string): void {
  if (isBlockedIp(hostname)) {
    throw new Error(
      `Blocked IP range: ${hostname}. Private IPs are not allowed`
    );
  }
}

function assertHostnameSuffixAllowed(hostname: string): void {
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(
      `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`
    );
  }
}

export function validateAndNormalizeUrl(urlString: string): string {
  assertUrlProvided(urlString);

  const trimmedUrl = urlString.trim();
  assertUrlNotEmpty(trimmedUrl);
  assertUrlLength(trimmedUrl);

  const url = parseUrl(trimmedUrl);
  assertProtocolAllowed(url);
  assertNoCredentials(url);

  const hostname = url.hostname.toLowerCase();
  assertHostnamePresent(hostname);
  assertHostnameAllowed(hostname);
  assertHostnameNotIpBlocked(hostname);
  assertHostnameSuffixAllowed(hostname);

  return url.href;
}

export function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    const urlObj = new URL(url, baseUrl);
    const baseUrlObj = new URL(baseUrl);
    return urlObj.hostname === baseUrlObj.hostname;
  } catch {
    return false;
  }
}
