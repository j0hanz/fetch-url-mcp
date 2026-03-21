import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/* -------------------------------------------------------------------------------------------------
 * Session data model
 * ------------------------------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------------------------------
 * Close handler composition
 * ------------------------------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------------------------------
 * In-memory session store
 * ------------------------------------------------------------------------------------------------- */

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private inflight = 0;

  constructor(private readonly sessionTtlMs: number) {}

  get(sessionId: string): SessionEntry | undefined {
    if (sessionId.length === 0) return undefined;
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    if (sessionId.length === 0) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSeen = Date.now();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  set(sessionId: string, entry: SessionEntry): void {
    if (sessionId.length === 0) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
  }

  remove(sessionId: string): SessionEntry | undefined {
    if (sessionId.length === 0) return undefined;
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
    if (this.inflight === 0) return;
    this.inflight -= 1;
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
      if (this.sessionTtlMs > 0 && now - session.lastSeen > this.sessionTtlMs) {
        this.sessions.delete(id);
        evicted.push(session);
      } else {
        break;
      }
    }

    return evicted;
  }

  evictOldest(): SessionEntry | undefined {
    const oldest = this.sessions.keys().next();
    if (oldest.done) return undefined;

    const session = this.sessions.get(oldest.value);
    this.sessions.delete(oldest.value);
    return session;
  }
}

export function createSessionStore(sessionTtlMs: number): SessionStore {
  return new InMemorySessionStore(sessionTtlMs);
}

/* -------------------------------------------------------------------------------------------------
 * Slot tracking and capacity
 * ------------------------------------------------------------------------------------------------- */

export function createSlotTracker(store: SessionStore): SlotTracker {
  let slotReleased = false;
  let initialized = false;

  return {
    releaseSlot(): void {
      if (slotReleased) return;
      slotReleased = true;
      store.decrementInFlight();
    },
    markInitialized(): void {
      initialized = true;
    },
    isInitialized(): boolean {
      return initialized;
    },
  };
}

export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (maxSessions <= 0) return false;
  if (store.size() + store.inFlight() >= maxSessions) return false;

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
  if (maxSessions <= 0) return false;

  const currentSize = store.size();
  const inflight = store.inFlight();

  if (currentSize + inflight < maxSessions) return true;

  const canFreeSlot =
    currentSize >= maxSessions && currentSize - 1 + inflight < maxSessions;

  if (!canFreeSlot) return false;
  if (!evictOldest(store)) return false;

  return store.size() + store.inFlight() < maxSessions;
}
