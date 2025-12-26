import type { Request } from 'express';

import type { SessionEntry } from '../config/types.js';

export interface SessionStore {
  get: (sessionId: string) => SessionEntry | undefined;
  touch: (sessionId: string) => void;
  set: (sessionId: string, entry: SessionEntry) => void;
  remove: (sessionId: string) => SessionEntry | undefined;
  size: () => number;
  clear: () => SessionEntry[];
  evictExpired: () => SessionEntry[];
  evictOldest: () => SessionEntry | undefined;
}

export function getSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

export function createSessionStore(sessionTtlMs: number): SessionStore {
  const sessions = new Map<string, SessionEntry>();

  return {
    get: (sessionId) => sessions.get(sessionId),
    touch: (sessionId) => {
      touchSession(sessions, sessionId);
    },
    set: (sessionId, entry) => {
      sessions.set(sessionId, entry);
    },
    remove: (sessionId) => removeSession(sessions, sessionId),
    size: () => sessions.size,
    clear: () => clearSessions(sessions),
    evictExpired: () => evictExpiredSessions(sessions, sessionTtlMs),
    evictOldest: () => evictOldestSession(sessions),
  };
}

function touchSession(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastSeen = Date.now();
  }
}

function removeSession(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): SessionEntry | undefined {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  return session;
}

function clearSessions(sessions: Map<string, SessionEntry>): SessionEntry[] {
  const entries = Array.from(sessions.values());
  sessions.clear();
  return entries;
}

function evictExpiredSessions(
  sessions: Map<string, SessionEntry>,
  sessionTtlMs: number
): SessionEntry[] {
  const now = Date.now();
  const evicted: SessionEntry[] = [];

  for (const [id, session] of sessions.entries()) {
    if (now - session.lastSeen > sessionTtlMs) {
      sessions.delete(id);
      evicted.push(session);
    }
  }

  return evicted;
}

function evictOldestSession(
  sessions: Map<string, SessionEntry>
): SessionEntry | undefined {
  let oldestId: string | undefined;
  let oldestSeen = Number.POSITIVE_INFINITY;

  for (const [id, session] of sessions.entries()) {
    if (session.lastSeen < oldestSeen) {
      oldestSeen = session.lastSeen;
      oldestId = id;
    }
  }

  if (!oldestId) return undefined;
  const session = sessions.get(oldestId);
  sessions.delete(oldestId);
  return session;
}
