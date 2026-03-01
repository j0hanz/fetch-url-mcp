import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSessionStore,
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
} from '../dist/lib/core.js';
import type { SessionStore } from '../dist/lib/core.js';

type SessionEntry = Parameters<SessionStore['set']>[1];

function createMockSessionEntry(): SessionEntry {
  return {
    transport: { close: async () => {} },
    createdAt: Date.now(),
    lastSeen: Date.now(),
    protocolInitialized: false,
    authFingerprint: 'test',
  } as SessionEntry;
}

function createStore(initialSize: number): SessionStore {
  const store = createSessionStore(60_000);
  const baseEntry = createMockSessionEntry();

  for (let index = 0; index < initialSize; index += 1) {
    store.set(`session-${index}`, {
      ...baseEntry,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
  }

  return store;
}

function testReservesAndReleasesSlots() {
  const store = createStore(0);
  const reserved = reserveSessionSlot(store, 1);
  assert.equal(reserved, true);
  const tracker = createSlotTracker(store);
  tracker.releaseSlot();
}

function testTracksInitializationState() {
  const store = createStore(0);
  const tracker = createSlotTracker(store);
  assert.equal(tracker.isInitialized(), false);
  tracker.markInitialized();
  assert.equal(tracker.isInitialized(), true);
  tracker.releaseSlot();
}

function testRejectsWhenAtCapacityWithoutEviction() {
  const store = createStore(1);

  const allowed = ensureSessionCapacity({
    store,
    maxSessions: 1,
    evictOldest: () => false,
  });

  assert.equal(allowed, false);
}

function testAllowsWhenEvictionFreesCapacity() {
  const store = createStore(1);

  const allowed = ensureSessionCapacity({
    store,
    maxSessions: 1,
    evictOldest: (targetStore) => {
      targetStore.clear();
      return true;
    },
  });

  assert.equal(allowed, true);
}

function registerMcpSessionHelpersTests() {
  describe('mcp-session-slots', () => {
    it('reserves and releases session slots', () => {
      testReservesAndReleasesSlots();
    });
    it('tracks initialization state', () => {
      testTracksInitializationState();
    });
    it('returns false when at capacity without eviction', () => {
      testRejectsWhenAtCapacityWithoutEviction();
    });
    it('allows when eviction frees capacity', () => {
      testAllowsWhenEvictionFreesCapacity();
    });
  });
}

registerMcpSessionHelpersTests();
