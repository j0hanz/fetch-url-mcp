import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { setInterval as setIntervalPromise } from 'node:timers/promises';

import {
  logInfo,
  logWarn,
  unregisterMcpSessionServerByServer,
} from './observability.js';

export interface SessionEntry {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  protocolInitialized: boolean;
  negotiatedProtocolVersion: string;
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

interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}

type CloseHandler = (() => void) | undefined;

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
const SESSION_CLOSE_BATCH_SIZE = 10;

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

function getRejectedSettledResult<T>(
  result: PromiseSettledResult<T>
): PromiseRejectedResult | undefined {
  return result.status === 'rejected' ? result : undefined;
}

function logRejectedSettledResults(
  results: readonly PromiseSettledResult<unknown>[],
  message: string
): void {
  for (const result of results) {
    const rejected = getRejectedSettledResult(result);
    if (!rejected) continue;

    logWarn(message, { error: formatError(rejected.reason) });
  }
}

function isSessionExpired(
  session: SessionEntry,
  now: number,
  sessionTtlMs: number
): boolean {
  if (sessionTtlMs <= 0) return false;
  return now - session.lastSeen > sessionTtlMs;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

      for (const batch of chunkArray(evicted, SESSION_CLOSE_BATCH_SIZE)) {
        const results = await Promise.allSettled(
          batch.map(async (session) => this.closeExpiredSession(session))
        );

        logRejectedSettledResults(
          results,
          'Failed to process expired session cleanup task'
        );

        if (signal.aborted) return;
      }

      if (evicted.length > 0) {
        logInfo('Expired sessions evicted', {
          evicted: evicted.length,
          timestamp: new Date(now).toISOString(),
        });
      }
    }
  }

  private async closeExpiredSession(session: SessionEntry): Promise<void> {
    try {
      unregisterMcpSessionServerByServer(session.server);
    } catch (error) {
      logWarn('Failed to unregister session server', {
        error: formatError(error),
      });
    }

    const [transportResult, serverResult] = await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);

    const transportRejected = getRejectedSettledResult(transportResult);
    const serverRejected = getRejectedSettledResult(serverResult);

    this.logCloseFailure('transport', transportRejected?.reason);
    this.logCloseFailure('server', serverRejected?.reason);
  }

  private logCloseFailure(
    target: 'transport' | 'server',
    error: unknown
  ): void {
    if (error == null) return;

    logWarn(`Failed to close expired session ${target}`, {
      error: formatError(error),
    });
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

function removeSessionById(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): SessionEntry | undefined {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  return session;
}

function isBlankSessionId(sessionId: string): boolean {
  return sessionId.length === 0;
}

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private inflight = 0;

  constructor(private readonly sessionTtlMs: number) {}

  get(sessionId: string): SessionEntry | undefined {
    if (isBlankSessionId(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    if (isBlankSessionId(sessionId)) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSeen = Date.now();
    moveSessionToEnd(this.sessions, sessionId, session);
  }

  set(sessionId: string, entry: SessionEntry): void {
    if (isBlankSessionId(sessionId)) return;
    moveSessionToEnd(this.sessions, sessionId, entry);
  }

  remove(sessionId: string): SessionEntry | undefined {
    if (isBlankSessionId(sessionId)) return undefined;
    return removeSessionById(this.sessions, sessionId);
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

    return removeSessionById(this.sessions, oldest.value);
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
