import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getRequestId, runWithRequestContext } from '../dist/observability.js';
import {
  getTransformPoolStats,
  shutdownTransformWorkerPool,
  transformHtmlToMarkdown,
} from '../dist/transform/transform.js';

describe('worker pool scaling', () => {
  afterEach(async () => {
    await shutdownTransformWorkerPool();
  });

  it('getTransformPoolStats returns null before pool is created', () => {
    const stats = getTransformPoolStats();
    assert.equal(stats, null, 'stats should be null when pool not initialized');
  });

  it('getTransformPoolStats returns stats after pool is used', async () => {
    // Trigger pool creation by running a transform
    await transformHtmlToMarkdown(
      '<html><body><p>Hello</p></body></html>',
      'https://example.com',
      { includeMetadata: false, signal: AbortSignal.timeout(5000) }
    );

    const stats = getTransformPoolStats();
    assert.ok(stats, 'stats should be defined after pool use');
    assert.equal(typeof stats.queueDepth, 'number');
    assert.equal(typeof stats.activeWorkers, 'number');
    assert.equal(typeof stats.capacity, 'number');
    assert.ok(stats.capacity >= 2, 'min capacity should be 2');
    assert.ok(stats.capacity <= 4, 'max capacity should be 4');
  });

  it('pool capacity respects min/max bounds (2-4)', async () => {
    // Fire a small transform to initialize pool
    await transformHtmlToMarkdown(
      '<html><body><p>Test</p></body></html>',
      'https://example.com',
      { includeMetadata: false, signal: AbortSignal.timeout(5000) }
    );

    const stats = getTransformPoolStats();
    assert.ok(stats, 'stats should exist');
    // Capacity starts at min (2) and can grow up to max (4)
    assert.ok(
      stats.capacity >= 2 && stats.capacity <= 4,
      `capacity ${stats.capacity} should be between 2 and 4`
    );
  });

  it('preserves async request context when worker tasks complete', async () => {
    const requestId = await runWithRequestContext(
      { requestId: 'pool-context-request', operationId: 'pool-context-op' },
      async () => {
        await transformHtmlToMarkdown(
          '<html><body><p>Context</p></body></html>',
          'https://example.com/context',
          { includeMetadata: false, signal: AbortSignal.timeout(5000) }
        );

        return getRequestId();
      }
    );

    assert.equal(requestId, 'pool-context-request');
  });
});
