import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { logInfo } from './logger.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionTtlMs: number;
  private cleanupTimeout: NodeJS.Timeout | null = null;

  constructor(sessionTtlMs = 30 * 60 * 1000) {
    this.sessionTtlMs = sessionTtlMs;
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, transport: StreamableHTTPServerTransport): void {
    this.sessions.set(sessionId, { transport, createdAt: Date.now() });
    logInfo('Session initialized', { sessionId });
    this.scheduleCleanup();
  }

  update(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.createdAt = Date.now();
      return true;
    }
    return false;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    logInfo('Session closed', { sessionId });
  }

  get size(): number {
    return this.sessions.size;
  }

  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      closePromises.push(session.transport.close());
    }
    await Promise.allSettled(closePromises);
    this.sessions.clear();
  }

  private async removeExpiredAndIdleSessions(): Promise<void> {
    const now = Date.now();
    const closePromises: Promise<void>[] = [];

    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.createdAt > this.sessionTtlMs) {
        logInfo('Cleaning up stale session', { sessionId });
        closePromises.push(entry.transport.close());
        this.sessions.delete(sessionId);
      }
    }

    await Promise.allSettled(closePromises);
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimeout) return;

    this.cleanupTimeout = setTimeout(
      () => {
        void this.removeExpiredAndIdleSessions().then(() => {
          this.cleanupTimeout = null;
          if (this.sessions.size > 0) this.scheduleCleanup();
        });
      },
      2 * 60 * 1000
    );

    this.cleanupTimeout.unref();
  }

  destroy(): void {
    if (this.cleanupTimeout) {
      clearInterval(this.cleanupTimeout);
      this.cleanupTimeout = null;
    }
  }
}
