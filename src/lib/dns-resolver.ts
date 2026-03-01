import dns from 'node:dns';
import { isIP } from 'node:net';

import { createErrorWithCode, isSystemError } from './errors.js';
import { logDebug } from './observability.js';
import { isError } from './type-guards.js';
import {
  type IpBlocker,
  isCloudMetadataHost,
  isLocalFetchAllowed,
} from './url-security.js';

// ---------------------------------------------------------------------------
// DNS helpers
// ---------------------------------------------------------------------------

const DNS_LOOKUP_TIMEOUT_MS = 5000;
const CNAME_LOOKUP_MAX_DEPTH = 5;

export function normalizeDnsName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/, '');
  return normalized;
}

// ---------------------------------------------------------------------------
// Abort-race helper
// ---------------------------------------------------------------------------

interface AbortRace {
  abortPromise: Promise<never>;
  cleanup: () => void;
}

export function createSignalAbortRace(
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

// ---------------------------------------------------------------------------
// Generic timeout wrapper
// ---------------------------------------------------------------------------

export async function withTimeout<T>(
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

// ---------------------------------------------------------------------------
// Abort signal error factory (DNS-specific)
// ---------------------------------------------------------------------------

export function createAbortSignalError(): Error {
  const err = new Error('Request was canceled');
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// SafeDnsResolver
// ---------------------------------------------------------------------------

interface SecurityConfig {
  blockedHosts: ReadonlySet<string>;
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

// ---------------------------------------------------------------------------
// DNS preflight factory
// ---------------------------------------------------------------------------

export type HostnamePreflight = (
  url: string,
  signal?: AbortSignal
) => Promise<string>;

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
