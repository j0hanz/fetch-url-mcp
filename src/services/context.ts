import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  readonly requestId: string;
  readonly sessionId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return requestContext.run(context, fn);
}

export function bindToRequestContext<T extends (...args: unknown[]) => unknown>(
  fn: T
): T {
  const store = requestContext.getStore();

  if (!store) {
    return fn;
  }

  return ((...args: Parameters<T>): ReturnType<T> =>
    requestContext.run(store, () => fn(...args)) as ReturnType<T>) as T;
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}
