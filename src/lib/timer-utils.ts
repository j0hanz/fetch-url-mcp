import {
  setInterval as setIntervalPromise,
  setTimeout as setTimeoutPromise,
} from 'node:timers/promises';

import { isAbortError } from './errors.js';

export interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel: () => void;
}

interface IntervalLoopOptions<T> {
  signal: AbortSignal;
  onTick: (value: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
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

export function startAbortableIntervalLoop<T>(
  intervalMs: number,
  value: T,
  options: IntervalLoopOptions<T>
): void {
  const ticks = setIntervalPromise(intervalMs, value, {
    signal: options.signal,
    ref: false,
  });

  void (async () => {
    try {
      for await (const tickValue of ticks) {
        await options.onTick(tickValue);
        if (options.signal.aborted) return;
      }
    } catch (error: unknown) {
      if (isAbortError(error)) return;
      options.onError?.(error);
    }
  })();
}
