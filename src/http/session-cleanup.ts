import { setInterval as setIntervalPromise } from 'node:timers/promises';

import { logInfo, logWarn } from '../services/logger.js';

import { evictExpiredSessions } from './mcp-session.js';
import type { SessionStore } from './sessions.js';

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

async function runSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number,
  signal: AbortSignal
): Promise<void> {
  const intervalMs = getCleanupIntervalMs(sessionTtlMs);
  for await (const _ of setIntervalPromise(intervalMs, undefined, {
    signal,
    ref: false,
  })) {
    handleSessionEvictions(store);
  }
}

function getCleanupIntervalMs(sessionTtlMs: number): number {
  return Math.min(Math.max(Math.floor(sessionTtlMs / 2), 10000), 60000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleSessionEvictions(store: SessionStore): void {
  const evicted = evictExpiredSessions(store);
  if (evicted > 0) {
    logInfo('Expired sessions evicted', { evicted });
  }
}

function handleSessionCleanupError(error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
  logWarn('Session cleanup loop failed', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}
