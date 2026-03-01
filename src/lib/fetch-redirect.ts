import { isIP } from 'node:net';
import tls from 'node:tls';

import { Agent, type Dispatcher } from 'undici';

import { config } from './config.js';
import { createErrorWithCode } from './errors.js';
import { createFetchError } from './fetch-errors.js';
import { isObject } from './type-guards.js';

// ---------------------------------------------------------------------------
// Redirect status helpers
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

export function cancelResponseBody(response: Response): void {
  const cancelPromise = response.body?.cancel();
  if (!cancelPromise) return;

  void cancelPromise.catch(() => undefined);
}

// ---------------------------------------------------------------------------
// MaxBytesError (stream truncation sentinel)
// ---------------------------------------------------------------------------

export class MaxBytesError extends Error {
  constructor() {
    super('max-bytes-reached');
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type NormalizeUrl = (urlString: string) => string;

type RedirectPreflight = (url: string, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// RedirectFollower
// ---------------------------------------------------------------------------

export class RedirectFollower {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly normalizeUrl: NormalizeUrl,
    private readonly preflight?: RedirectPreflight
  ) {}

  async fetchWithRedirects(
    url: string,
    init: RequestInit,
    maxRedirects: number
  ): Promise<{ response: Response; url: string }> {
    let currentUrl = url;
    const redirectLimit = Math.max(0, maxRedirects);

    for (
      let redirectCount = 0;
      redirectCount <= redirectLimit;
      redirectCount += 1
    ) {
      const { response, nextUrl } = await this.withRedirectErrorContext(
        currentUrl,
        async () => {
          let ipAddress: string | undefined;
          if (this.preflight) {
            ipAddress = await this.preflight(
              currentUrl,
              init.signal ?? undefined
            );
          }
          return this.performFetchCycle(
            currentUrl,
            init,
            redirectLimit,
            redirectCount,
            ipAddress
          );
        }
      );

      if (!nextUrl) return { response, url: currentUrl };
      currentUrl = nextUrl;
    }

    throw createFetchError({ kind: 'too-many-redirects' }, currentUrl);
  }

  private async performFetchCycle(
    currentUrl: string,
    init: RequestInit,
    redirectLimit: number,
    redirectCount: number,
    ipAddress?: string
  ): Promise<{ response: Response; nextUrl?: string }> {
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      ...init,
      redirect: 'manual' as RequestRedirect,
    };
    if (ipAddress) {
      const ca =
        tls.rootCertificates.length > 0 ? tls.rootCertificates : undefined;
      const agent = new Agent({
        connect: {
          lookup: (hostname, options, callback) => {
            const family = isIP(ipAddress) === 6 ? 6 : 4;
            if (options.all) {
              callback(null, [{ address: ipAddress, family }]);
            } else {
              callback(null, ipAddress, family);
            }
          },
          timeout: config.fetcher.timeout,
          ...(ca ? { ca } : {}),
        },
        pipelining: 1,
        connections: 1,
        keepAliveTimeout: 1000,
        keepAliveMaxTimeout: 1000,
      });
      fetchInit.dispatcher = agent;
    }

    const response = await this.fetchFn(currentUrl, fetchInit);

    if (!isRedirectStatus(response.status)) return { response };

    if (redirectCount >= redirectLimit) {
      cancelResponseBody(response);
      throw createFetchError({ kind: 'too-many-redirects' }, currentUrl);
    }

    const location = this.getRedirectLocation(response, currentUrl);
    cancelResponseBody(response);

    const nextUrl = this.resolveRedirectTarget(currentUrl, location);
    const parsedNextUrl = new URL(nextUrl);
    if (
      parsedNextUrl.protocol !== 'http:' &&
      parsedNextUrl.protocol !== 'https:'
    ) {
      throw createErrorWithCode(
        `Unsupported redirect protocol: ${parsedNextUrl.protocol}`,
        'EUNSUPPORTEDPROTOCOL'
      );
    }

    return {
      response,
      nextUrl,
    };
  }

  private getRedirectLocation(response: Response, currentUrl: string): string {
    const location = response.headers.get('location');
    if (location) return location;

    cancelResponseBody(response);
    throw createFetchError({ kind: 'missing-redirect-location' }, currentUrl);
  }

  private resolveRedirectTarget(baseUrl: string, location: string): string {
    let resolved: URL;
    try {
      resolved = new URL(location, baseUrl);
    } catch {
      throw createErrorWithCode('Invalid redirect target', 'EBADREDIRECT');
    }
    if (resolved.username || resolved.password) {
      throw createErrorWithCode(
        'Redirect target includes credentials',
        'EBADREDIRECT'
      );
    }

    return this.normalizeUrl(resolved.href);
  }

  private annotateRedirectError(error: unknown, url: string): void {
    if (!isObject(error)) return;
    (error as Record<string, unknown>)['requestUrl'] = url;
  }

  private async withRedirectErrorContext<T>(
    url: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      this.annotateRedirectError(error, url);
      throw error;
    }
  }
}
