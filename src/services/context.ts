import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}
