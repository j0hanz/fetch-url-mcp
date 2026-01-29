import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { logInfo, logWarn } from './observability.js';

// --- Types ---

export interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  protocolInitialized: boolean;
}

export interface SessionStore {
  get: (sessionId: string) => SessionEntry | undefined;
  touch: (sessionId: string) => void;
  set: (sessionId: string, entry: SessionEntry) => void;
  remove: (sessionId: string) => SessionEntry | undefined;
  size: () => number;
  inFlight: () => number;
  incrementInFlight: () => void;
  decrementInFlight: () => void;
  clear: () => SessionEntry[];
  evictExpired: () => SessionEntry[];
  evictOldest: () => SessionEntry | undefined;
}

export interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}

// --- Close Handlers ---

export type CloseHandler = (() => void) | undefined;

export function composeCloseHandlers(
  first: CloseHandler,
  second: CloseHandler
): CloseHandler {
  if (!first) return second;
  if (!second) return first;
  return () => {
    try {
      first();
    } finally {
      second();
    }
  };
}

// --- Session Store ---

function getCleanupIntervalMs(sessionTtlMs: number): number {
  return Math.min(Math.max(Math.floor(sessionTtlMs / 2), 10000), 60000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleSessionCleanupError(error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
  logWarn('Session cleanup loop failed', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}

function moveSessionToEnd(
  sessions: Map<string, SessionEntry>,
  sessionId: string,
  session: SessionEntry
): void {
  sessions.delete(sessionId);
  sessions.set(sessionId, session);
}

function isSessionExpired(
  session: SessionEntry,
  now: number,
  sessionTtlMs: number
): boolean {
  return now - session.lastSeen > sessionTtlMs;
}

async function runSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number,
  signal: AbortSignal
): Promise<void> {
  const intervalMs = getCleanupIntervalMs(sessionTtlMs);
  for await (const getNow of setIntervalPromise(intervalMs, Date.now, {
    signal,
    ref: false,
  })) {
    const evicted = store.evictExpired();
    for (const session of evicted) {
      void session.transport.close().catch((err: unknown) => {
        logWarn('Failed to close expired session', {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }
    if (evicted.length > 0) {
      logInfo('Expired sessions evicted', {
        evicted: evicted.length,
        timestamp: new Date(getNow()).toISOString(),
      });
    }
  }
}

export function startSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number
): AbortController {
  const controller = new AbortController();
  void runSessionCleanupLoop(store, sessionTtlMs, controller.signal).catch(
    handleSessionCleanupError
  );
  return controller;
}

export function createSessionStore(sessionTtlMs: number): SessionStore {
  const sessions = new Map<string, SessionEntry>();
  let inflight = 0;

  return {
    get: (sessionId) => sessions.get(sessionId),
    touch: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.lastSeen = Date.now();
        // Move to end (LRU behavior if needed, but Map insertion order)
        moveSessionToEnd(sessions, sessionId, session);
      }
    },
    set: (sessionId, entry) => {
      sessions.set(sessionId, entry);
    },
    remove: (sessionId) => {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      return session;
    },
    size: () => sessions.size,
    inFlight: () => inflight,
    incrementInFlight: () => {
      inflight += 1;
    },
    decrementInFlight: () => {
      if (inflight > 0) inflight -= 1;
    },
    clear: () => {
      const entries = [...sessions.values()];
      sessions.clear();
      return entries;
    },
    evictExpired: () => {
      const now = Date.now();
      const evicted: SessionEntry[] = [];
      for (const [id, session] of sessions.entries()) {
        if (isSessionExpired(session, now, sessionTtlMs)) {
          sessions.delete(id);
          evicted.push(session);
        }
      }
      return evicted;
    },
    evictOldest: () => {
      const oldestEntry = sessions.keys().next();
      if (oldestEntry.done) return undefined;
      const oldestId = oldestEntry.value;
      const session = sessions.get(oldestId);
      sessions.delete(oldestId);
      return session;
    },
  };
}

// --- Slot Tracker ---

export function createSlotTracker(store: SessionStore): SlotTracker {
  let slotReleased = false;
  let initialized = false;
  return {
    releaseSlot: (): void => {
      if (slotReleased) return;
      slotReleased = true;
      store.decrementInFlight();
    },
    markInitialized: (): void => {
      initialized = true;
    },
    isInitialized: (): boolean => initialized,
  };
}

export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (store.size() + store.inFlight() >= maxSessions) {
    return false;
  }
  store.incrementInFlight();
  return true;
}

export function ensureSessionCapacity({
  store,
  maxSessions,
  evictOldest,
}: {
  store: SessionStore;
  maxSessions: number;
  evictOldest: (store: SessionStore) => boolean;
}): boolean {
  const currentSize = store.size();
  const isAtCapacity = currentSize + store.inFlight() >= maxSessions;

  if (!isAtCapacity) return true;

  // Try to free a slot
  const canFreeSlot =
    currentSize >= maxSessions &&
    currentSize - 1 + store.inFlight() < maxSessions;

  if (canFreeSlot && evictOldest(store)) {
    return store.size() + store.inFlight() < maxSessions;
  }

  return false;
}
