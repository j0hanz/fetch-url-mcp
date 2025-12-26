import { setTimeout } from 'node:timers/promises';

import { FetchError } from '../../errors/app-error.js';

import { logDebug, logWarn } from '../logger.js';

export class RetryPolicy {
  private static readonly BASE_DELAY_MS = 1000;
  private static readonly MAX_DELAY_MS = 10000;
  private static readonly JITTER_FACTOR = 0.25;

  constructor(
    private readonly maxRetries: number,
    private readonly url: string
  ) {}

  async execute<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error = new Error(`Failed to fetch ${this.url}`);
    const retries = this.normalizeRetries();

    for (let attempt = 1; attempt <= retries; attempt++) {
      const result = await this.runAttempt(operation, attempt, retries, signal);
      if (result.done) return result.value;
      lastError = result.error;
    }

    throw this.buildFinalError(retries, lastError);
  }

  private async runAttempt<T>(
    operation: () => Promise<T>,
    attempt: number,
    retries: number,
    signal?: AbortSignal
  ): Promise<{ done: true; value: T } | { done: false; error: Error }> {
    this.throwIfAborted(signal);

    try {
      const value = await operation();
      return { done: true, value };
    } catch (error) {
      const normalizedError = this.normalizeError(error);
      this.throwIfNotRetryable(attempt, retries, normalizedError);
      await this.wait(attempt, normalizedError, signal);
      return { done: false, error: normalizedError };
    }
  }

  private throwIfNotRetryable(
    attempt: number,
    retries: number,
    error: Error
  ): void {
    if (!this.shouldRetry(attempt, retries, error)) {
      throw error;
    }
  }

  private shouldRetry(
    attempt: number,
    maxRetries: number,
    error: Error
  ): boolean {
    if (attempt >= maxRetries) return false;
    if (!(error instanceof FetchError)) return true;
    if (this.isAbortError(error)) return false;
    if (this.isRateLimited(error)) return true;
    return !this.isClientError(error);
  }

  private async wait(
    attempt: number,
    error: Error,
    signal?: AbortSignal
  ): Promise<void> {
    const delay = this.calculateDelay(attempt, error);

    this.logRetryDelay(attempt, delay, error);
    await this.sleep(delay, signal);
  }

  private calculateDelay(attempt: number, error: Error): number {
    const rateLimitDelay = this.getRateLimitDelay(error);
    if (rateLimitDelay !== null) return rateLimitDelay;

    const exponentialDelay = Math.min(
      RetryPolicy.BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RetryPolicy.MAX_DELAY_MS
    );
    const jitter =
      exponentialDelay * RetryPolicy.JITTER_FACTOR * (Math.random() * 2 - 1);
    return Math.round(exponentialDelay + jitter);
  }

  private normalizeRetries(): number {
    return Math.min(Math.max(1, this.maxRetries), 10);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw new FetchError('Request was aborted before execution', this.url);
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private buildFinalError(retries: number, error: Error): FetchError {
    return new FetchError(
      `Failed after ${retries} attempts: ${error.message}`,
      this.url
    );
  }

  private isAbortError(error: FetchError): boolean {
    return error.details.reason === 'aborted';
  }

  private isRateLimited(error: FetchError): boolean {
    return error.details.httpStatus === 429;
  }

  private isClientError(error: FetchError): boolean {
    const status = error.details.httpStatus as number | undefined;
    return Boolean(status && status >= 400 && status < 500);
  }

  private logRetryDelay(attempt: number, delay: number, error: Error): void {
    if (this.isRateLimitLog(error)) {
      logWarn('Rate limited, waiting before retry', {
        url: this.url,
        attempt,
        waitTime: `${delay}ms`,
      });
      return;
    }

    logDebug('Retrying request', {
      url: this.url,
      attempt,
      delay: `${delay}ms`,
    });
  }

  private isRateLimitLog(error: Error): error is FetchError {
    return error instanceof FetchError && error.details.httpStatus === 429;
  }

  private async sleep(delay: number, signal?: AbortSignal): Promise<void> {
    try {
      await setTimeout(delay, undefined, { signal });
    } catch (timeoutError) {
      this.handleSleepError(timeoutError);
    }
  }

  private handleSleepError(error: unknown): void {
    if (this.isAbortTimeout(error)) {
      throw new FetchError(
        'Request was aborted during retry wait',
        this.url,
        499,
        {
          reason: 'aborted',
        }
      );
    }
    throw error;
  }

  private isAbortTimeout(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    );
  }

  private getRateLimitDelay(error: Error): number | null {
    if (!(error instanceof FetchError)) return null;
    if (error.details.httpStatus !== 429) return null;

    const retryAfter = (error.details.retryAfter as number) || 60;
    return Math.min(retryAfter * 1000, 30000);
  }
}
