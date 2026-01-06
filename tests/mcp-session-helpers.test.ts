import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
} from '../dist/http/mcp-session-helpers.js';
import type { SessionStore } from '../dist/http/sessions.js';

function createStore(initialSize: number) {
  let currentSize = initialSize;
  return {
    size: () => currentSize,
    setSize: (size: number) => {
      currentSize = size;
    },
  };
}

describe('mcp-session-helpers', () => {
  it('reserves and releases session slots', () => {
    const store = createStore(0);
    const reserved = reserveSessionSlot(store as SessionStore, 1);
    assert.equal(reserved, true);
    const tracker = createSlotTracker();
    tracker.releaseSlot();
  });

  it('tracks initialization state', () => {
    const tracker = createSlotTracker();
    assert.equal(tracker.isInitialized(), false);
    tracker.markInitialized();
    assert.equal(tracker.isInitialized(), true);
    tracker.releaseSlot();
  });

  it('returns false and responds when at capacity without eviction', () => {
    const store = createStore(1);
    let statusCode: number | undefined;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    };

    const allowed = ensureSessionCapacity(
      store as SessionStore,
      1,
      res as never,
      () => false
    );

    assert.equal(allowed, false);
    assert.equal(statusCode, 503);
  });

  it('allows when eviction frees capacity', () => {
    const store = createStore(1);
    const res = { status: () => res, json: () => res };

    const allowed = ensureSessionCapacity(
      store as SessionStore,
      1,
      res as never,
      () => {
        store.setSize(0);
        return true;
      }
    );

    assert.equal(allowed, true);
  });
});
