import { UrlValidationError, ValidationError } from '../errors/app-error.js';

// Maximum URL length to prevent DoS attacks
const MAX_URL_LENGTH = 2048;

// Blocked hosts to prevent SSRF attacks
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata endpoint
  'metadata.google.internal', // GCP metadata
  'metadata.azure.com', // Azure metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'instance-data', // Common cloud metadata hostname
]);

// Blocked IP patterns (private networks)
const BLOCKED_IP_PATTERNS: readonly RegExp[] = [
  /^10\./, // Private Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // Private Class B
  /^192\.168\./, // Private Class C
  /^127\./, // Loopback
  /^0\./, // Current network
  /^169\.254\./, // Link-local
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
  /^::ffff:127\./, // IPv4-mapped IPv6 loopback
  /^::ffff:10\./, // IPv4-mapped IPv6 private
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./, // IPv4-mapped IPv6 private
  /^::ffff:192\.168\./, // IPv4-mapped IPv6 private
];

/**
 * Checks if a hostname matches blocked IP patterns
 */
function isBlockedIp(hostname: string): boolean {
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Validates and normalizes a URL, blocking SSRF attack vectors
 * @throws {ValidationError} if URL is empty or too long
 * @throws {UrlValidationError} if URL is invalid or blocked
 */
export function validateAndNormalizeUrl(urlString: string): string {
  // Check for empty or whitespace-only input
  if (!urlString || typeof urlString !== 'string') {
    throw new ValidationError('URL is required');
  }

  const trimmedUrl = urlString.trim();
  if (!trimmedUrl) {
    throw new ValidationError('URL cannot be empty');
  }

  // Check URL length to prevent DoS
  if (trimmedUrl.length > MAX_URL_LENGTH) {
    throw new ValidationError(
      `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
      { length: trimmedUrl.length, maxLength: MAX_URL_LENGTH }
    );
  }

  let url: URL;

  try {
    url = new URL(trimmedUrl);
  } catch {
    throw new UrlValidationError(`Invalid URL format`, trimmedUrl);
  }

  // Only allow HTTP(S) protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError(
      `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`,
      trimmedUrl
    );
  }

  // Block URLs with credentials (user:pass@host)
  if (url.username || url.password) {
    throw new UrlValidationError(
      'URLs with embedded credentials are not allowed',
      trimmedUrl
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Block empty hostname
  if (!hostname) {
    throw new UrlValidationError('URL must have a valid hostname', trimmedUrl);
  }

  // Block known internal/metadata hosts
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new UrlValidationError(
      `Blocked host: ${hostname}. Internal hosts are not allowed`,
      trimmedUrl
    );
  }

  // Block private IP ranges
  if (isBlockedIp(hostname)) {
    throw new UrlValidationError(
      `Blocked IP range: ${hostname}. Private IPs are not allowed`,
      trimmedUrl
    );
  }

  // Block hostnames that look like they might resolve to internal addresses
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new UrlValidationError(
      `Blocked hostname pattern: ${hostname}. Internal domain suffixes are not allowed`,
      trimmedUrl
    );
  }

  return url.href;
}

/**
 * Checks if a URL is internal (same domain)
 */
export function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    const urlObj = new URL(url, baseUrl);
    const baseUrlObj = new URL(baseUrl);
    return urlObj.hostname === baseUrlObj.hostname;
  } catch {
    return false;
  }
}
