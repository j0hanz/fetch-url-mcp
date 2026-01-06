import type { Response } from 'express';

import type { SessionStore } from './sessions.js';

export interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}

let inFlightSessions = 0;

export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (store.size() + inFlightSessions >= maxSessions) {
    return false;
  }
  inFlightSessions += 1;
  return true;
}

function releaseSessionSlot(): void {
  if (inFlightSessions > 0) {
    inFlightSessions -= 1;
  }
}

export function createSlotTracker(): SlotTracker {
  let slotReleased = false;
  let initialized = false;
  return {
    releaseSlot: (): void => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSessionSlot();
    },
    markInitialized: (): void => {
      initialized = true;
    },
    isInitialized: (): boolean => initialized,
  };
}

export function ensureSessionCapacity(
  store: SessionStore,
  maxSessions: number,
  res: Response,
  evictOldest: (store: SessionStore) => boolean
): boolean {
  if (!isServerAtCapacity(store, maxSessions)) {
    return true;
  }

  if (tryEvictSlot(store, maxSessions, evictOldest)) {
    return !isServerAtCapacity(store, maxSessions);
  }

  respondServerBusy(res);
  return false;
}

function isServerAtCapacity(store: SessionStore, maxSessions: number): boolean {
  return store.size() + inFlightSessions >= maxSessions;
}

function tryEvictSlot(
  store: SessionStore,
  maxSessions: number,
  evictOldest: (store: SessionStore) => boolean
): boolean {
  const currentSize = store.size();
  const canFreeSlot =
    currentSize >= maxSessions &&
    currentSize - 1 + inFlightSessions < maxSessions;
  return canFreeSlot && evictOldest(store);
}

function sendJsonRpcError(
  res: Response,
  code: number,
  message: string,
  status = 503
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
    id: null,
  });
}

export function respondServerBusy(res: Response): void {
  sendJsonRpcError(res, -32000, 'Server busy: maximum sessions reached', 503);
}

export function respondBadRequest(res: Response): void {
  sendJsonRpcError(
    res,
    -32000,
    'Bad Request: Missing session ID or not an initialize request',
    400
  );
}
