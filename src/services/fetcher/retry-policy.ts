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
    const retries = Math.min(Math.max(1, this.maxRetries), 10);

    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) {
        throw new FetchError('Request was aborted before execution', this.url);
      }

      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.shouldRetry(attempt, retries, lastError)) {
          throw lastError;
        }

        await this.wait(attempt, lastError, signal);
      }
    }

    throw new FetchError(
      `Failed after ${retries} attempts: ${lastError.message}`,
      this.url
    );
  }

  private shouldRetry(
    attempt: number,
    maxRetries: number,
    error: Error
  ): boolean {
    if (attempt >= maxRetries) return false;

    if (error instanceof FetchError) {
      if (error.details.reason === 'aborted') return false;
      if (error.details.httpStatus === 429) return true;

      const status = error.details.httpStatus as number | undefined;
      if (status && status >= 400 && status < 500) return false;
    }

    return true;
  }

  private async wait(
    attempt: number,
    error: Error,
    signal?: AbortSignal
  ): Promise<void> {
    const delay = this.calculateDelay(attempt, error);

    if (error instanceof FetchError && error.details.httpStatus === 429) {
      logWarn('Rate limited, waiting before retry', {
        url: this.url,
        attempt,
        waitTime: `${delay}ms`,
      });
    } else {
      logDebug('Retrying request', {
        url: this.url,
        attempt,
        delay: `${delay}ms`,
      });
    }

    try {
      await setTimeout(delay, undefined, { signal });
    } catch (timeoutError) {
      if (
        timeoutError instanceof Error &&
        (timeoutError.name === 'AbortError' ||
          timeoutError.name === 'TimeoutError')
      ) {
        throw new FetchError(
          'Request was aborted during retry wait',
          this.url,
          499,
          {
            reason: 'aborted',
          }
        );
      }
      throw timeoutError;
    }
  }

  private calculateDelay(attempt: number, error: Error): number {
    if (error instanceof FetchError && error.details.httpStatus === 429) {
      const retryAfter = (error.details.retryAfter as number) || 60;
      return Math.min(retryAfter * 1000, 30000);
    }

    const exponentialDelay = Math.min(
      RetryPolicy.BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RetryPolicy.MAX_DELAY_MS
    );
    const jitter =
      exponentialDelay * RetryPolicy.JITTER_FACTOR * (Math.random() * 2 - 1);
    return Math.round(exponentialDelay + jitter);
  }
}
