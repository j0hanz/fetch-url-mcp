import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { isError } from './type-guards.js';

export interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function isAbortError(error: unknown): boolean {
  return isError(error) && error.name === 'AbortError';
}

function createAbortSafeTimeoutPromise<T>(
  timeoutMs: number,
  value: T,
  signal: AbortSignal
): Promise<T> {
  return setTimeoutPromise(timeoutMs, value, {
    ref: false,
    signal,
  }).catch((err: unknown) => {
    if (isAbortError(err)) {
      return new Promise<T>(() => {});
    }
    throw err;
  });
}

export function createUnrefTimeout<T>(
  timeoutMs: number,
  value: T
): CancellableTimeout<T> {
  const controller = new AbortController();
  const promise = createAbortSafeTimeoutPromise(
    timeoutMs,
    value,
    controller.signal
  );

  return {
    promise,
    cancel: () => {
      controller.abort();
    },
  };
}
