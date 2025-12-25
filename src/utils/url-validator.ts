import { BlockList, isIP } from 'node:net';

import { config } from '../config/index.js';

const BLOCK_LIST = new BlockList();
const BLOCKED_IPV4_SUBNETS = [
  { subnet: '0.0.0.0', prefix: 8 },
  { subnet: '10.0.0.0', prefix: 8 },
  { subnet: '100.64.0.0', prefix: 10 },
  { subnet: '127.0.0.0', prefix: 8 },
  { subnet: '169.254.0.0', prefix: 16 },
  { subnet: '172.16.0.0', prefix: 12 },
  { subnet: '192.168.0.0', prefix: 16 },
  { subnet: '224.0.0.0', prefix: 4 },
  { subnet: '240.0.0.0', prefix: 4 },
] as const;
const BLOCKED_IPV6_SUBNETS = [
  { subnet: '::', prefix: 128 },
  { subnet: '::1', prefix: 128 },
  { subnet: '::ffff:0:0', prefix: 96 },
  { subnet: '64:ff9b::', prefix: 96 },
  { subnet: '64:ff9b:1::', prefix: 48 },
  { subnet: '2001::', prefix: 32 },
  { subnet: '2002::', prefix: 16 },
  { subnet: 'fc00::', prefix: 7 },
  { subnet: 'fe80::', prefix: 10 },
  { subnet: 'ff00::', prefix: 8 },
] as const;

for (const entry of BLOCKED_IPV4_SUBNETS) {
  BLOCK_LIST.addSubnet(entry.subnet, entry.prefix);
}

interface Ipv6Subnet {
  network: bigint;
  prefix: number;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number.parseInt(part, 10));
  if (bytes.some((byte) => Number.isNaN(byte) || byte < 0 || byte > 255)) {
    return null;
  }
  if (bytes.length !== 4) return null;
  const [b1, b2, b3, b4] = bytes;
  if (
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined ||
    b4 === undefined
  ) {
    return null;
  }
  return [b1, b2, b3, b4];
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  const zoneIndex = ip.indexOf('%');
  const address = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  const lower = address.toLowerCase();
  const hasCompression = lower.includes('::');

  if (hasCompression && lower.indexOf('::') !== lower.lastIndexOf('::')) {
    return null;
  }

  const [leftRaw, rightRaw] = hasCompression ? lower.split('::') : [lower, ''];
  const leftParts = leftRaw ? leftRaw.split(':') : [];
  const rightParts = rightRaw ? rightRaw.split(':') : [];

  const filler = new Array<string>(
    Math.max(0, 8 - (leftParts.length + rightParts.length))
  ).fill('0');
  let parts: string[] = hasCompression
    ? [...leftParts, ...filler, ...rightParts]
    : [...leftParts];

  const ipv4Index = parts.findIndex((part) => part.includes('.'));
  if (ipv4Index >= 0) {
    const ipv4Part = parts[ipv4Index];
    if (!ipv4Part) return null;
    const ipv4Bytes = parseIpv4(ipv4Part);
    if (!ipv4Bytes) return null;
    const [b1, b2, b3, b4] = ipv4Bytes;
    const high = ((b1 << 8) | b2).toString(16);
    const low = ((b3 << 8) | b4).toString(16);
    parts = [
      ...parts.slice(0, ipv4Index),
      high,
      low,
      ...parts.slice(ipv4Index + 1),
    ];
  }

  if (parts.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const part of parts) {
    const segment = part === '' ? 0 : Number.parseInt(part, 16);
    if (Number.isNaN(segment) || segment < 0 || segment > 0xffff) {
      return null;
    }
    value = (value << 16n) + BigInt(segment);
  }

  return value;
}

function buildIpv6Subnets(): Ipv6Subnet[] {
  const networks: Ipv6Subnet[] = [];
  for (const entry of BLOCKED_IPV6_SUBNETS) {
    const parsed = parseIpv6ToBigInt(entry.subnet);
    if (parsed === null) {
      continue;
    }
    networks.push({ network: parsed, prefix: entry.prefix });
  }
  return networks;
}

const BLOCKED_IPV6_NETWORKS = buildIpv6Subnets();

function matchesIpv6Subnet(ip: string): boolean {
  const ipValue = parseIpv6ToBigInt(ip);
  if (ipValue === null) return false;
  const fullMask = (1n << 128n) - 1n;

  for (const subnet of BLOCKED_IPV6_NETWORKS) {
    const prefix = BigInt(subnet.prefix);
    const mask =
      subnet.prefix === 0 ? 0n : (fullMask << (128n - prefix)) & fullMask;
    if ((ipValue & mask) === subnet.network) {
      return true;
    }
  }
  return false;
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
  const ipType = isIP(ip);
  if (!ipType) return false;
  const normalizedIp = ip.toLowerCase();
  if (ipType === 4 && BLOCK_LIST.check(normalizedIp)) return true;
  if (
    ipType === 6 &&
    (BLOCK_LIST.check(normalizedIp) || matchesIpv6Subnet(normalizedIp))
  ) {
    return true;
  }
  return matchesBlockedIpPatterns(normalizedIp);
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
  if (!URL.canParse(trimmedUrl)) {
    throw new Error('Invalid URL format');
  }
  return new URL(trimmedUrl);
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
  if (!URL.canParse(baseUrl) || !URL.canParse(url, baseUrl)) {
    return false;
  }
  const urlObj = new URL(url, baseUrl);
  const baseUrlObj = new URL(baseUrl);
  return urlObj.hostname === baseUrlObj.hostname;
}
