import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { getRequestId, runWithRequestContext } from '../dist/lib/core.js';
import { withRequestContextIfMissing } from '../dist/tools/fetch-url.js';

describe('withRequestContextIfMissing', () => {
  it('establishes a request context when none exists', async () => {
    const wrapped = withRequestContextIfMissing(async (_params: unknown) => {
      return getRequestId();
    });

    assert.equal(getRequestId(), undefined);
    const requestId = await wrapped({});
    assert.ok(requestId);
    assert.equal(getRequestId(), undefined);
  });

  it('uses the MCP requestId when provided via handler extra', async () => {
    const wrapped = withRequestContextIfMissing(async (_params: unknown) => {
      return getRequestId();
    });

    assert.equal(getRequestId(), undefined);
    const requestId = await wrapped({}, { requestId: 'mcp-request-123' });
    assert.equal(requestId, 'mcp-request-123');
    assert.equal(getRequestId(), undefined);
  });

  it('preserves an existing request context', async () => {
    const wrapped = withRequestContextIfMissing(async (_params: unknown) => {
      return getRequestId();
    });

    const requestId = await runWithRequestContext(
      { requestId: 'existing-request', operationId: 'existing-op' },
      async () => wrapped({})
    );

    assert.equal(requestId, 'existing-request');
  });
});

describe('Progress notification timeout', () => {
  it('times out progress notifications after 5 seconds', async () => {
    const { createProgressReporter } = await import('../dist/lib/mcp-tools.js');
    const startTime = Date.now();

    // Mock sendNotification that takes 10 seconds (longer than 5-second timeout)
    const sendNotificationMock = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    });

    const extra = {
      _meta: { progressToken: 'test-token' },
      sendNotification: sendNotificationMock,
    };

    const reporter = createProgressReporter(extra);

    // Progress report should timeout after 5 seconds, not wait 10 seconds
    await reporter.report(50, 'test progress');

    const elapsedMs = Date.now() - startTime;

    // Verify it completed in less than 8 seconds (giving buffer for test execution)
    assert.ok(
      elapsedMs < 8000,
      `Expected timeout within 8s but took ${elapsedMs}ms`
    );

    // Verify sendNotification was called
    assert.equal(sendNotificationMock.mock.calls.length, 1);
  });
});
