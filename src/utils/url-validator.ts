import { UrlValidationError } from '../errors/app-error.js';

// Blocked hosts to prevent SSRF attacks
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata endpoint
  'metadata.google.internal', // GCP metadata
  'metadata.azure.com', // Azure metadata
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
];

/**
 * Checks if a hostname matches blocked IP patterns
 */
function isBlockedIp(hostname: string): boolean {
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Validates and normalizes a URL, blocking SSRF attack vectors
 * @throws {UrlValidationError} if URL is invalid or blocked
 */
export function validateAndNormalizeUrl(urlString: string): string {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    throw new UrlValidationError(`Invalid URL format`, urlString);
  }

  // Only allow HTTP(S) protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError(
      `Invalid protocol: ${url.protocol}. Only http: and https: are allowed`,
      urlString
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Block known internal/metadata hosts
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new UrlValidationError(
      `Blocked host: ${hostname}. Internal hosts are not allowed`,
      urlString
    );
  }

  // Block private IP ranges
  if (isBlockedIp(hostname)) {
    throw new UrlValidationError(
      `Blocked IP range: ${hostname}. Private IPs are not allowed`,
      urlString
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
