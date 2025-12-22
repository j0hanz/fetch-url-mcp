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

  const get = (sessionId: string): SessionEntry | undefined =>
    sessions.get(sessionId);

  const touch = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastSeen = Date.now();
    }
  };

  const set = (sessionId: string, entry: SessionEntry): void => {
    sessions.set(sessionId, entry);
  };

  const remove = (sessionId: string): SessionEntry | undefined => {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    return session;
  };

  const size = (): number => sessions.size;

  const clear = (): SessionEntry[] => {
    const entries = Array.from(sessions.values());
    sessions.clear();
    return entries;
  };

  const evictExpired = (): SessionEntry[] => {
    const now = Date.now();
    const evicted: SessionEntry[] = [];

    for (const [id, session] of sessions.entries()) {
      if (now - session.lastSeen > sessionTtlMs) {
        sessions.delete(id);
        evicted.push(session);
      }
    }

    return evicted;
  };

  const evictOldest = (): SessionEntry | undefined => {
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
  };

  return {
    get,
    touch,
    set,
    remove,
    size,
    clear,
    evictExpired,
    evictOldest,
  };
}
