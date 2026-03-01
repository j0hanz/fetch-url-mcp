import { FetchError } from './errors.js';
import { isObject } from './type-guards.js';

export function getAbortReason(signal: AbortSignal): unknown {
  const record = isObject(signal) ? (signal as Record<string, unknown>) : null;
  return record && 'reason' in record ? record['reason'] : undefined;
}

export function isTimeoutAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  const reason = getAbortReason(signal);
  if (isTimeoutAbortReason(reason)) {
    throw new FetchError('Request timeout', url, 504, {
      reason: 'timeout',
      stage,
    });
  }

  throw new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}

export function createAbortError(url: string, stage: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}
