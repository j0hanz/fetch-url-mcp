import { FetchError } from '../../errors/app-error.js';

import { createErrorWithCode } from '../../utils/error-utils.js';
import { isRecord } from '../../utils/guards.js';
import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function cancelResponseBody(response: Response): void {
  const cancelPromise = response.body?.cancel();
  if (cancelPromise) {
    cancelPromise.catch(() => {
      // Best-effort cancellation; ignore failures.
    });
  }
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

  assertRedirectWithinLimit(response, currentUrl, redirectLimit, redirectCount);
  const location = getRedirectLocation(response, currentUrl);

  cancelResponseBody(response);
  return {
    response,
    nextUrl: resolveRedirectTarget(currentUrl, location),
  };
}

function assertRedirectWithinLimit(
  response: Response,
  currentUrl: string,
  redirectLimit: number,
  redirectCount: number
): void {
  if (redirectCount < redirectLimit) return;
  cancelResponseBody(response);
  throw new FetchError('Too many redirects', currentUrl);
}

function getRedirectLocation(response: Response, currentUrl: string): string {
  const location = response.headers.get('location');
  if (location) return location;

  cancelResponseBody(response);
  throw new FetchError('Redirect response missing Location header', currentUrl);
}

function annotateRedirectError(error: unknown, url: string): void {
  if (!isRecord(error)) return;
  error.requestUrl = url;
}

function resolveRedirectTarget(baseUrl: string, location: string): string {
  if (!URL.canParse(location, baseUrl)) {
    throw createErrorWithCode('Invalid redirect target', 'EBADREDIRECT');
  }

  const resolved = new URL(location, baseUrl);
  if (resolved.username || resolved.password) {
    throw createErrorWithCode(
      'Redirect target includes credentials',
      'EBADREDIRECT'
    );
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
