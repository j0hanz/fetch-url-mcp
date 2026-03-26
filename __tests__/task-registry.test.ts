import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  getTaskCapableTool,
  getTaskCapableToolSupport,
  hasRegisteredTaskCapableTools,
  hasTaskCapableTool,
  registerTaskCapableTool,
  setTaskCapableToolSupport,
  unregisterTaskCapableTool,
} from '../dist/tasks/registry.js';

// ── Task-capable tool registry ──────────────────────────────────────

function makeDummyDescriptor(
  name: string,
  taskSupport?: 'optional' | 'forbidden'
) {
  return {
    name,
    parseArguments: (args: unknown) => args,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    ...(taskSupport !== undefined ? { taskSupport } : {}),
  };
}

describe('task-capable tool registry', () => {
  afterEach(() => {
    // Clean up any tools registered during the test.
    for (const name of ['alpha', 'beta', 'gamma']) {
      unregisterTaskCapableTool(name);
    }
  });

  // ── registerTaskCapableTool ───────────────────────────────────

  describe('registerTaskCapableTool', () => {
    it('registers a tool and makes it retrievable', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha'));
      assert.ok(hasTaskCapableTool('alpha'));
      assert.ok(getTaskCapableTool('alpha'));
    });

    it('defaults taskSupport to "optional" when not provided', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha'));
      assert.equal(getTaskCapableToolSupport('alpha'), 'optional');
    });

    it('preserves explicit "forbidden" taskSupport', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha', 'forbidden'));
      assert.equal(getTaskCapableToolSupport('alpha'), 'forbidden');
    });

    it('overwrites a previous registration', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha', 'optional'));
      registerTaskCapableTool(makeDummyDescriptor('alpha', 'forbidden'));
      assert.equal(getTaskCapableToolSupport('alpha'), 'forbidden');
    });
  });

  // ── unregisterTaskCapableTool ─────────────────────────────────

  describe('unregisterTaskCapableTool', () => {
    it('removes a registered tool', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha'));
      unregisterTaskCapableTool('alpha');
      assert.equal(hasTaskCapableTool('alpha'), false);
      assert.equal(getTaskCapableTool('alpha'), undefined);
    });

    it('does not throw for an unregistered name', () => {
      assert.doesNotThrow(() => unregisterTaskCapableTool('nonexistent'));
    });
  });

  // ── getTaskCapableTool / getTaskCapableToolSupport ────────────

  describe('getTaskCapableTool / getTaskCapableToolSupport', () => {
    it('returns undefined for unknown tools', () => {
      assert.equal(getTaskCapableTool('nonexistent'), undefined);
      assert.equal(getTaskCapableToolSupport('nonexistent'), undefined);
    });
  });

  // ── hasRegisteredTaskCapableTools ─────────────────────────────

  describe('hasRegisteredTaskCapableTools', () => {
    it('returns false when registry is empty', () => {
      assert.equal(hasRegisteredTaskCapableTools(), false);
    });

    it('returns true after a tool is registered', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha'));
      assert.equal(hasRegisteredTaskCapableTools(), true);
    });
  });

  // ── setTaskCapableToolSupport ─────────────────────────────────

  describe('setTaskCapableToolSupport', () => {
    it('changes support level for an existing tool', () => {
      registerTaskCapableTool(makeDummyDescriptor('alpha', 'optional'));
      setTaskCapableToolSupport('alpha', 'forbidden');
      assert.equal(getTaskCapableToolSupport('alpha'), 'forbidden');
    });

    it('is a no-op for unregistered tools', () => {
      assert.doesNotThrow(() =>
        setTaskCapableToolSupport('nonexistent', 'optional')
      );
    });
  });
});
