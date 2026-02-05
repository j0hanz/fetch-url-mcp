import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { logInfo, logWarn } from './observability.js';

export interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  protocolInitialized: boolean;
  authFingerprint: string;
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

const MIN_CLEANUP_INTERVAL_MS = 10_000;
const MAX_CLEANUP_INTERVAL_MS = 60_000;

function getCleanupIntervalMs(sessionTtlMs: number): number {
  return Math.min(
    Math.max(Math.floor(sessionTtlMs / 2), MIN_CLEANUP_INTERVAL_MS),
    MAX_CLEANUP_INTERVAL_MS
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleSessionCleanupError(error: unknown): void {
  if (isAbortError(error)) return;
  logWarn('Session cleanup loop failed', { error: formatError(error) });
}

function isSessionExpired(
  session: SessionEntry,
  now: number,
  sessionTtlMs: number
): boolean {
  if (sessionTtlMs <= 0) return false;
  return now - session.lastSeen > sessionTtlMs;
}

class SessionCleanupLoop {
  constructor(
    private readonly store: SessionStore,
    private readonly sessionTtlMs: number
  ) {}

  start(): AbortController {
    const controller = new AbortController();
    void this.run(controller.signal).catch(handleSessionCleanupError);
    return controller;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const intervalMs = getCleanupIntervalMs(this.sessionTtlMs);

    const ticks = setIntervalPromise(intervalMs, Date.now, {
      signal,
      ref: false,
    });

    for await (const getNow of ticks) {
      const now = getNow();
      const evicted = this.store.evictExpired();

      for (const session of evicted) {
        void session.transport.close().catch((err: unknown) => {
          logWarn('Failed to close expired session', {
            error: formatError(err),
          });
        });
      }

      if (evicted.length > 0) {
        logInfo('Expired sessions evicted', {
          evicted: evicted.length,
          timestamp: new Date(now).toISOString(),
        });
      }
    }
  }
}

export function startSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number
): AbortController {
  return new SessionCleanupLoop(store, sessionTtlMs).start();
}

function moveSessionToEnd(
  sessions: Map<string, SessionEntry>,
  sessionId: string,
  session: SessionEntry
): void {
  sessions.delete(sessionId);
  sessions.set(sessionId, session);
}

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private inflight = 0;

  constructor(private readonly sessionTtlMs: number) {}

  get(sessionId: string): SessionEntry | undefined {
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    if (!sessionId) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSeen = Date.now();
    moveSessionToEnd(this.sessions, sessionId, session);
  }

  set(sessionId: string, entry: SessionEntry): void {
    if (!sessionId) return;
    moveSessionToEnd(this.sessions, sessionId, entry);
  }

  remove(sessionId: string): SessionEntry | undefined {
    if (!sessionId) return undefined;

    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return session;
  }

  size(): number {
    return this.sessions.size;
  }

  inFlight(): number {
    return this.inflight;
  }

  incrementInFlight(): void {
    this.inflight += 1;
  }

  decrementInFlight(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  clear(): SessionEntry[] {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    return entries;
  }

  evictExpired(): SessionEntry[] {
    const now = Date.now();
    const evicted: SessionEntry[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (!isSessionExpired(session, now, this.sessionTtlMs)) continue;
      this.sessions.delete(id);
      evicted.push(session);
    }

    return evicted;
  }

  evictOldest(): SessionEntry | undefined {
    const oldest = this.sessions.keys().next();
    if (oldest.done) return undefined;

    const oldestId = oldest.value;
    const session = this.sessions.get(oldestId);
    this.sessions.delete(oldestId);
    return session;
  }
}

export function createSessionStore(sessionTtlMs: number): SessionStore {
  return new InMemorySessionStore(sessionTtlMs);
}

class SessionSlotTracker implements SlotTracker {
  private slotReleased = false;
  private initialized = false;

  constructor(private readonly store: SessionStore) {}

  releaseSlot(): void {
    if (this.slotReleased) return;
    this.slotReleased = true;
    this.store.decrementInFlight();
  }

  markInitialized(): void {
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export function createSlotTracker(store: SessionStore): SlotTracker {
  return new SessionSlotTracker(store);
}

function currentLoad(store: SessionStore): number {
  return store.size() + store.inFlight();
}

export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (maxSessions <= 0) return false;
  if (currentLoad(store) >= maxSessions) return false;

  store.incrementInFlight();
  return true;
}

function isAtCapacity(store: SessionStore, maxSessions: number): boolean {
  return currentLoad(store) >= maxSessions;
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
  if (maxSessions <= 0) return false;

  const currentSize = store.size();
  const inflight = store.inFlight();

  if (currentSize + inflight < maxSessions) return true;

  const canFreeSlot =
    currentSize >= maxSessions && currentSize - 1 + inflight < maxSessions;

  if (!canFreeSlot) return false;
  if (!evictOldest(store)) return false;

  return !isAtCapacity(store, maxSessions);
}
