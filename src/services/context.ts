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
  return AsyncLocalStorage.bind(fn);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}
