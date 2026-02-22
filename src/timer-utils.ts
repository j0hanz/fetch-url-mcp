import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { isError } from './type-guards.js';

export interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function isAbortError(error: unknown): boolean {
  return isError(error) && error.name === 'AbortError';
}

function createPendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export function createUnrefTimeout<T>(
  timeoutMs: number,
  value: T
): CancellableTimeout<T> {
  const controller = new AbortController();

  const promise = setTimeoutPromise(timeoutMs, value, {
    ref: false,
    signal: controller.signal,
  }).catch((err: unknown) => {
    if (isAbortError(err)) {
      return createPendingPromise<T>();
    }
    throw err;
  });

  return {
    promise,
    cancel: () => {
      controller.abort();
    },
  };
}
