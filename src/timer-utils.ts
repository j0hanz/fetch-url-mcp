import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { isError } from './type-guards.js';

export interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel: () => void;
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
    if (isError(err) && err.name === 'AbortError') {
      return new Promise<T>(() => {});
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
