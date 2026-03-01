import type { config } from './config.js';
import { createErrorWithCode } from './errors.js';
import {
  createDefaultBlockList,
  normalizeIpForBlockList,
} from './ip-blocklist.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

export function createValidationError(message: string): Error {
  return createErrorWithCode(message, VALIDATION_ERROR_CODE);
}

// ---------------------------------------------------------------------------
// Cloud-metadata & blocked-host constants
// ---------------------------------------------------------------------------

export const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.local', '.internal'];

const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure
  'metadata.google.internal', // GCP
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IPv6
]);

export function isCloudMetadataHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(lowered)) return true;
  const normalized = normalizeIpForBlockList(lowered);
  return normalized !== null && CLOUD_METADATA_HOSTS.has(normalized.ip);
}

export function isLocalFetchAllowed(): boolean {
  return process.env['ALLOW_LOCAL_FETCH'] === 'true';
}

// ---------------------------------------------------------------------------
// IP blocking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL normalizer
// ---------------------------------------------------------------------------

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
