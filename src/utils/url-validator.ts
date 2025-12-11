import { UrlValidationError, ValidationError } from '../errors/app-error.js';

const MAX_URL_LENGTH = 2048;

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  '100.100.100.200',
  'instance-data',
]);

const BLOCKED_IP_PATTERNS: readonly RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fe80:/i,
  /^::ffff:127\./,
  /^::ffff:10\./,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
  /^::ffff:192\.168\./,
];

function isBlockedIp(hostname: string): boolean {
  return BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

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

export function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    const urlObj = new URL(url, baseUrl);
    const baseUrlObj = new URL(baseUrl);
    return urlObj.hostname === baseUrlObj.hostname;
  } catch {
    return false;
  }
}
