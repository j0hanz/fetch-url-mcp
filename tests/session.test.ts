import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import * as http from '../dist/session.js';

describe('http session utilities', () => {
  describe('createSlotTracker', () => {
    it('creates slot tracker with required methods', () => {
      const store = http.createSessionStore(60000);
      const tracker = http.createSlotTracker(store);
      assert.ok(tracker, 'Should create tracker');
      assert.ok(typeof tracker.releaseSlot === 'function');
      assert.ok(typeof tracker.markInitialized === 'function');
      assert.ok(typeof tracker.isInitialized === 'function');
    });

    it('tracks initialization state', () => {
      const store = http.createSessionStore(60000);
      const tracker = http.createSlotTracker(store);

      assert.equal(
        tracker.isInitialized(),
        false,
        'Should start uninitialized'
      );

      tracker.markInitialized();
      assert.equal(
        tracker.isInitialized(),
        true,
        'Should be initialized after mark'
      );
    });

    it('releases slot only once', () => {
      const store = http.createSessionStore(60000);
      const tracker = http.createSlotTracker(store);

      // First release should work
      tracker.releaseSlot();

      // Second release should be idempotent (no error)
      tracker.releaseSlot();
      tracker.releaseSlot();

      assert.ok(true, 'Multiple releases should be safe');
    });
  });

  describe('createSessionStore', () => {
    it('creates session store with specified TTL', () => {
      const ttlMs = 60000; // 1 minute
      const store = http.createSessionStore(ttlMs);

      assert.ok(store, 'Should create store');
      assert.ok(typeof store.get === 'function');
      assert.ok(typeof store.set === 'function');
      assert.ok(typeof store.remove === 'function');
      assert.ok(typeof store.touch === 'function');
      assert.ok(typeof store.size === 'function');
      assert.ok(typeof store.clear === 'function');
      assert.ok(typeof store.evictExpired === 'function');
      assert.ok(typeof store.evictOldest === 'function');
    });

    it('stores and retrieves sessions', () => {
      const store = http.createSessionStore(60000);
      const sessionId = 'test-session-123';
      const mockTransport = { close: () => Promise.resolve() } as any;

      const entry = {
        transport: mockTransport,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        protocolInitialized: false,

        authFingerprint: 'test',
      };

      store.set(sessionId, entry);
      const retrieved = store.get(sessionId);

      assert.ok(retrieved, 'Should retrieve session');
      assert.equal(retrieved.protocolInitialized, false);
    });

    it('removes sessions', () => {
      const store = http.createSessionStore(60000);
      const sessionId = 'remove-test';
      const mockTransport = { close: () => Promise.resolve() } as any;

      const entry = {
        transport: mockTransport,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        protocolInitialized: false,

        authFingerprint: 'test',
      };

      store.set(sessionId, entry);
      assert.ok(store.get(sessionId), 'Session should exist');

      const removed = store.remove(sessionId);
      assert.ok(removed, 'Should return removed session');
      assert.equal(
        store.get(sessionId),
        undefined,
        'Session should be removed'
      );
    });

    it('touches sessions to update lastSeen', () => {
      const store = http.createSessionStore(60000);
      const sessionId = 'touch-test';
      const mockTransport = { close: () => Promise.resolve() } as any;

      const initialTime = Date.now();
      const entry = {
        transport: mockTransport,
        createdAt: initialTime,
        lastSeen: initialTime,
        protocolInitialized: false,

        authFingerprint: 'test',
      };

      store.set(sessionId, entry);

      // Touch should update lastSeen
      store.touch(sessionId);

      const touched = store.get(sessionId);
      assert.ok(touched, 'Session should still exist');
      assert.ok(touched.lastSeen >= initialTime, 'lastSeen should be updated');
    });

    it('clears all sessions', () => {
      const store = http.createSessionStore(60000);
      const mockTransport = { close: () => Promise.resolve() } as any;

      const entry = {
        transport: mockTransport,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        protocolInitialized: false,

        authFingerprint: 'test',
      };

      store.set('session-1', entry);
      store.set('session-2', entry);
      store.set('session-3', entry);

      assert.equal(store.size(), 3, 'Should have 3 sessions');

      const cleared = store.clear();
      assert.equal(cleared.length, 3, 'Should return all cleared sessions');
      assert.equal(store.size(), 0, 'Store should be empty after clear');
    });

    it('reports correct store size', () => {
      const store = http.createSessionStore(60000);
      const mockTransport = { close: () => Promise.resolve() } as any;

      const entry = {
        transport: mockTransport,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        protocolInitialized: false,

        authFingerprint: 'test',
      };

      assert.equal(store.size(), 0, 'Initial size should be 0');

      store.set('s1', entry);
      store.set('s2', entry);
      assert.equal(store.size(), 2, 'Size should be 2 after adding');

      store.remove('s1');
      assert.equal(store.size(), 1, 'Size should be 1 after removing');
    });

    it('evicts oldest session', () => {
      const store = http.createSessionStore(60000);
      const mockTransport = { close: () => Promise.resolve() } as any;

      // Add sessions with different lastSeen times
      const now = Date.now();
      store.set('oldest', {
        transport: mockTransport,
        createdAt: now - 3000,
        lastSeen: now - 3000,
        protocolInitialized: false,

        authFingerprint: 'test',
      });

      store.set('middle', {
        transport: mockTransport,
        createdAt: now - 2000,
        lastSeen: now - 2000,
        protocolInitialized: false,

        authFingerprint: 'test',
      });

      store.set('newest', {
        transport: mockTransport,
        createdAt: now,
        lastSeen: now,
        protocolInitialized: false,

        authFingerprint: 'test',
      });

      const evicted = store.evictOldest();
      assert.ok(evicted, 'Should evict a session');
      assert.equal(store.size(), 2, 'Should have 2 sessions remaining');
      assert.equal(
        store.get('oldest'),
        undefined,
        'Oldest session should be evicted'
      );
      assert.ok(store.get('middle'), 'Middle session should remain');
      assert.ok(store.get('newest'), 'Newest session should remain');
    });

    it('evicts expired sessions based on TTL', () => {
      const ttlMs = 100; // 100ms TTL for testing
      const store = http.createSessionStore(ttlMs);
      const mockTransport = { close: () => Promise.resolve() } as any;

      const now = Date.now();

      // Add expired session
      store.set('expired', {
        transport: mockTransport,
        createdAt: now - 200,
        lastSeen: now - 200,
        protocolInitialized: false,

        authFingerprint: 'test',
      });

      // Add fresh session
      store.set('fresh', {
        transport: mockTransport,
        createdAt: now,
        lastSeen: now,
        protocolInitialized: false,

        authFingerprint: 'test',
      });

      const evicted = store.evictExpired();
      assert.equal(evicted.length, 1, 'Should evict 1 expired session');
      assert.equal(store.size(), 1, 'Should have 1 session remaining');
      assert.equal(
        store.get('expired'),
        undefined,
        'Expired session should be removed'
      );
      assert.ok(store.get('fresh'), 'Fresh session should remain');
    });

    it('runs expired-session cleanup hook when cleanup loop evicts sessions', async () => {
      const ttlMs = 5;
      const store = http.createSessionStore(ttlMs);
      const calls: string[] = [];

      store.set('expired-loop', {
        server: {
          close: async () => {
            calls.push('server.close');
          },
        },
        transport: {
          close: async () => {
            calls.push('transport.close');
          },
        },
        createdAt: Date.now() - 100,
        lastSeen: Date.now() - 100,
        protocolInitialized: false,
        negotiatedProtocolVersion: '2025-11-25',
        authFingerprint: 'test',
      } as any);

      const cleanup = http.startSessionCleanupLoop(store, ttlMs, {
        cleanupIntervalMs: 5,
        onEvictSession: () => {
          calls.push('onEvictSession');
        },
      });

      try {
        await delay(40);
      } finally {
        cleanup.abort();
      }

      assert.equal(store.get('expired-loop'), undefined);
      assert.ok(calls.includes('onEvictSession'));
      assert.ok(calls.includes('transport.close'));
      assert.ok(calls.includes('server.close'));
    });
  });

  describe('composeCloseHandlers', () => {
    it('composes two close handlers', () => {
      const calls: string[] = [];

      const handler1 = () => calls.push('handler1');
      const handler2 = () => calls.push('handler2');

      const composed = http.composeCloseHandlers(handler1, handler2);
      assert.ok(composed, 'Should return composed handler');

      composed();

      assert.deepEqual(
        calls,
        ['handler1', 'handler2'],
        'Should call handlers in order'
      );
    });

    it('handles first handler being null/undefined', () => {
      const calls: string[] = [];
      const handler = () => calls.push('handler');

      const composed = http.composeCloseHandlers(null as any, handler);
      if (composed) {
        composed();
      }

      assert.deepEqual(calls, ['handler'], 'Should execute second handler');
    });

    it('handles second handler being null/undefined', () => {
      const calls: string[] = [];
      const handler = () => calls.push('handler');

      const composed = http.composeCloseHandlers(handler, null as any);
      if (composed) {
        composed();
      }

      assert.deepEqual(calls, ['handler'], 'Should execute first handler');
    });

    it('executes second handler even if first throws', () => {
      const calls: string[] = [];

      const handler1 = () => {
        throw new Error('handler1 failed');
      };
      const handler2 = () => calls.push('handler2');

      const composed = http.composeCloseHandlers(handler1, handler2);

      if (composed) {
        try {
          composed();
        } catch (error) {
          // Expected to throw
        }
      }

      assert.ok(
        calls.includes('handler2'),
        'Should execute handler2 despite handler1 error'
      );
    });
  });

  describe('ensureSessionCapacity', () => {
    it('allows session when under capacity', () => {
      const store = http.createSessionStore(60000);
      const maxSessions = 100;
      const mockRes = {} as any;
      const evictOldest = () => false;

      const allowed = http.ensureSessionCapacity({
        store,
        maxSessions,
        // res: mockRes, // Removed as it is not part of the signature
        evictOldest,
      });

      assert.equal(allowed, true, 'Should allow session when under capacity');
    });
  });

  describe('reserveSessionSlot', () => {
    it('reserves session slot when under capacity', () => {
      const store = http.createSessionStore(60000);
      const maxSessions = 100;

      const reserved = http.reserveSessionSlot(store, maxSessions);

      assert.equal(reserved, true, 'Should reserve slot when under capacity');
    });

    it('rejects reservation when at capacity', () => {
      const store = http.createSessionStore(60000);
      const maxSessions = 0; // No capacity

      const reserved = http.reserveSessionSlot(store, maxSessions);

      assert.equal(reserved, false, 'Should reject when at capacity');
    });
  });
});
