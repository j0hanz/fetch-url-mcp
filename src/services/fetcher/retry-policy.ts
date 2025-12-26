import { setTimeout } from 'node:timers/promises';

import { FetchError } from '../../errors/app-error.js';

import { logDebug, logWarn } from '../logger.js';

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;
const JITTER_FACTOR = 0.25;

export async function executeWithRetry<T>(
  url: string,
  maxRetries: number,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: Error = new Error(`Failed to fetch ${url}`);
  const retries = normalizeRetries(maxRetries);

  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await runAttempt(url, operation, attempt, retries, signal);
    if (result.done) return result.value;
    lastError = result.error;
  }

  throw buildFinalError(url, retries, lastError);
}

async function runAttempt<T>(
  url: string,
  operation: () => Promise<T>,
  attempt: number,
  retries: number,
  signal?: AbortSignal
): Promise<{ done: true; value: T } | { done: false; error: Error }> {
  throwIfAborted(url, signal);

  try {
    const value = await operation();
    return { done: true, value };
  } catch (error) {
    const normalizedError = normalizeError(error);
    throwIfNotRetryable(attempt, retries, normalizedError);
    await wait(url, attempt, normalizedError, signal);
    return { done: false, error: normalizedError };
  }
}

function throwIfNotRetryable(
  attempt: number,
  retries: number,
  error: Error
): void {
  if (!shouldRetry(attempt, retries, error)) {
    throw error;
  }
}

function shouldRetry(
  attempt: number,
  maxRetries: number,
  error: Error
): boolean {
  if (attempt >= maxRetries) return false;
  if (!(error instanceof FetchError)) return true;
  if (isAbortError(error)) return false;
  if (isRateLimited(error)) return true;
  return !isClientError(error);
}

async function wait(
  url: string,
  attempt: number,
  error: Error,
  signal?: AbortSignal
): Promise<void> {
  const delay = calculateDelay(attempt, error);

  logRetryDelay(url, attempt, delay, error);
  await sleep(url, delay, signal);
}

function calculateDelay(attempt: number, error: Error): number {
  const rateLimitDelay = getRateLimitDelay(error);
  if (rateLimitDelay !== null) return rateLimitDelay;

  const exponentialDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    MAX_DELAY_MS
  );
  const jitter = exponentialDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(exponentialDelay + jitter);
}

function normalizeRetries(maxRetries: number): number {
  return Math.min(Math.max(1, maxRetries), 10);
}

function throwIfAborted(url: string, signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new FetchError('Request was aborted before execution', url);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function buildFinalError(
  url: string,
  retries: number,
  error: Error
): FetchError {
  return new FetchError(
    `Failed after ${retries} attempts: ${error.message}`,
    url
  );
}

function isAbortError(error: FetchError): boolean {
  return error.details.reason === 'aborted';
}

function isRateLimited(error: FetchError): boolean {
  return error.details.httpStatus === 429;
}

function isClientError(error: FetchError): boolean {
  const status = error.details.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function logRetryDelay(
  url: string,
  attempt: number,
  delay: number,
  error: Error
): void {
  if (isRateLimitLog(error)) {
    logWarn('Rate limited, waiting before retry', {
      url,
      attempt,
      waitTime: `${delay}ms`,
    });
    return;
  }

  logDebug('Retrying request', {
    url,
    attempt,
    delay: `${delay}ms`,
  });
}

function isRateLimitLog(error: Error): error is FetchError {
  return error instanceof FetchError && error.details.httpStatus === 429;
}

async function sleep(
  url: string,
  delay: number,
  signal?: AbortSignal
): Promise<void> {
  try {
    await setTimeout(delay, undefined, { signal });
  } catch (timeoutError) {
    handleSleepError(url, timeoutError);
  }
}

function handleSleepError(url: string, error: unknown): void {
  if (isAbortTimeout(error)) {
    throw new FetchError('Request was aborted during retry wait', url, 499, {
      reason: 'aborted',
    });
  }
  throw error;
}

function isAbortTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function getRateLimitDelay(error: Error): number | null {
  if (!(error instanceof FetchError)) return null;
  if (error.details.httpStatus !== 429) return null;

  const retryAfter =
    typeof error.details.retryAfter === 'number'
      ? error.details.retryAfter
      : 60;
  return Math.min(retryAfter * 1000, 30000);
}
