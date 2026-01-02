import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { config } from '../config/index.js';

import { createErrorWithCode } from './error-utils.js';

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
  { subnet: '64:ff9b::', prefix: 96 },
  { subnet: '64:ff9b:1::', prefix: 48 },
  { subnet: '2001::', prefix: 32 },
  { subnet: '2002::', prefix: 16 },
  { subnet: 'fc00::', prefix: 7 },
  { subnet: 'fe80::', prefix: 10 },
  { subnet: 'ff00::', prefix: 8 },
] as const;

for (const entry of BLOCKED_IPV4_SUBNETS) {
  BLOCK_LIST.addSubnet(entry.subnet, entry.prefix, 'ipv4');
}
for (const entry of BLOCKED_IPV6_SUBNETS) {
  BLOCK_LIST.addSubnet(entry.subnet, entry.prefix, 'ipv6');
}

const DNS_LOOKUP_TIMEOUT_MS = 5000;
const DNS_DECISION_TTL_MS = 60000;
const DNS_DECISION_MAX = 1000;

interface DnsDecision {
  ok: boolean;
  expiresAt: number;
}

const dnsDecisionCache = new Map<string, DnsDecision>();

function getCachedDnsDecision(hostname: string): DnsDecision | null {
  const cached = dnsDecisionCache.get(hostname);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    dnsDecisionCache.delete(hostname);
    return null;
  }
  return cached;
}

function setCachedDnsDecision(hostname: string, ok: boolean): void {
  dnsDecisionCache.set(hostname, {
    ok,
    expiresAt: Date.now() + DNS_DECISION_TTL_MS,
  });

  if (dnsDecisionCache.size <= DNS_DECISION_MAX) return;
  const evictCount = Math.ceil(DNS_DECISION_MAX * 0.05);
  const iterator = dnsDecisionCache.keys();
  for (let i = 0; i < evictCount; i++) {
    const { value, done } = iterator.next();
    if (done) break;
    dnsDecisionCache.delete(value);
  }
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

function lookupWithTimeout(
  hostname: string
): Promise<LookupAddress[] | LookupAddress> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createValidationError(`DNS lookup timed out for ${hostname}`));
    }, DNS_LOOKUP_TIMEOUT_MS);

    lookup(hostname, { all: true })
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : createValidationError(String(error))
        );
      });
  });
}

export async function assertResolvedAddressesAllowed(
  hostname: string
): Promise<void> {
  const cached = getCachedDnsDecision(hostname);
  if (cached) {
    if (!cached.ok) {
      throw createValidationError(
        `Blocked IP range resolved from hostname: ${hostname}`
      );
    }
    return;
  }

  try {
    const result = await lookupWithTimeout(hostname);
    const addresses = Array.isArray(result) ? result : [result];
    if (addresses.length === 0) {
      throw createValidationError(`Unable to resolve hostname: ${hostname}`);
    }

    for (const { address } of addresses) {
      if (isBlockedIp(address.toLowerCase())) {
        setCachedDnsDecision(hostname, false);
        throw createValidationError(
          `Blocked IP range resolved from hostname: ${hostname}`
        );
      }
    }
    setCachedDnsDecision(hostname, true);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw createValidationError(`Unable to resolve hostname: ${hostname}`);
    }
    if (error instanceof Error) {
      throw error;
    }
    throw createValidationError(String(error));
  }
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

export async function validateAndNormalizeUrl(
  urlString: string
): Promise<string> {
  const { normalizedUrl, hostname } = normalizeUrl(urlString);
  await assertResolvedAddressesAllowed(hostname);
  return normalizedUrl;
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
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw createValidationError('URL must have a valid hostname');
  }
  return hostname;
}

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal'] as const;

function assertHostnameAllowed(hostname: string): void {
  if (config.security.blockedHosts.has(hostname)) {
    throw createValidationError(
      `Blocked host: ${hostname}. Internal hosts are not allowed`
    );
  }

  if (isBlockedIp(hostname)) {
    throw createValidationError(
      `Blocked IP range: ${hostname}. Private IPs are not allowed`
    );
  }

  if (matchesBlockedSuffix(hostname)) {
    throw createValidationError(
      `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`
    );
  }
}

function matchesBlockedSuffix(hostname: string): boolean {
  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}
