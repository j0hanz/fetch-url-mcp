import { FetchError } from '../../errors/app-error.js';

import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

interface FetchCycleResult {
  response: Response;
  nextUrl?: string;
}

async function performFetchCycle(
  currentUrl: string,
  init: RequestInit,
  redirectLimit: number,
  redirectCount: number
): Promise<FetchCycleResult> {
  const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

  if (!isRedirectStatus(response.status)) {
    return { response };
  }

  if (redirectCount >= redirectLimit) {
    void response.body?.cancel();
    throw new FetchError('Too many redirects', currentUrl);
  }

  const location = response.headers.get('location');
  if (!location) {
    void response.body?.cancel();
    throw new FetchError(
      'Redirect response missing Location header',
      currentUrl
    );
  }

  void response.body?.cancel();
  return {
    response,
    nextUrl: resolveRedirectTarget(currentUrl, location),
  };
}

function annotateRedirectError(error: unknown, url: string): void {
  if (!error || typeof error !== 'object') return;
  (error as { requestUrl?: string }).requestUrl = url;
}

export function resolveRedirectTarget(
  baseUrl: string,
  location: string
): string {
  if (!URL.canParse(location, baseUrl)) {
    const error = new Error('Invalid redirect target') as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  const resolved = new URL(location, baseUrl);
  if (resolved.username || resolved.password) {
    const error = new Error(
      'Redirect target includes credentials'
    ) as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  return validateAndNormalizeUrl(resolved.href);
}

export async function fetchWithRedirects(
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
    const { response, nextUrl } = await performFetchCycleSafely(
      currentUrl,
      init,
      redirectLimit,
      redirectCount
    );

    if (!nextUrl) {
      return { response, url: currentUrl };
    }

    currentUrl = nextUrl;
  }

  throw new FetchError('Too many redirects', currentUrl);
}

async function performFetchCycleSafely(
  currentUrl: string,
  init: RequestInit,
  redirectLimit: number,
  redirectCount: number
): Promise<FetchCycleResult> {
  try {
    return await performFetchCycle(
      currentUrl,
      init,
      redirectLimit,
      redirectCount
    );
  } catch (error) {
    annotateRedirectError(error, currentUrl);
    throw error;
  }
}
