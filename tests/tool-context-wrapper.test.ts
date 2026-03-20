import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { getRequestId, runWithRequestContext } from '../dist/lib/core.js';
import { withRequestContextIfMissing } from '../dist/tasks/owner.js';

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
  it('coalesces queued progress updates while one notification is in flight', async () => {
    const { createProgressReporter } = await import('../dist/lib/progress.js');
    let resolveFirstSend: (() => void) | undefined;
    const sentProgress: number[] = [];

    const sendNotificationMock = mock.fn(async (notification) => {
      sentProgress.push(
        (notification as { params: { progress: number } }).params.progress
      );

      if (sentProgress.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstSend = resolve;
        });
      }
    });

    const reporter = createProgressReporter({
      _meta: { progressToken: 'test-token' },
      sendNotification: sendNotificationMock,
    });

    reporter.report(1, 'Preparing request');
    reporter.report(2, 'Resolving URL');
    reporter.report(3, 'Checking cache');

    assert.equal(sendNotificationMock.mock.calls.length, 1);
    resolveFirstSend?.();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(sentProgress, [1, 3]);
    assert.equal(sendNotificationMock.mock.calls.length, 2);
  });

  it('times out an in-flight notification and then delivers the newest queued update', async () => {
    const { createProgressReporter } = await import('../dist/lib/progress.js');
    const sentProgress: number[] = [];

    const sendNotificationMock = mock.fn(async (notification) => {
      sentProgress.push(
        (notification as { params: { progress: number } }).params.progress
      );

      if (sentProgress.length === 1) {
        await new Promise(() => {});
      }
    });

    const reporter = createProgressReporter({
      _meta: { progressToken: 'test-timeout-token' },
      sendNotification: sendNotificationMock,
    });

    reporter.report(1, 'Preparing request');
    reporter.report(2, 'Resolving URL');

    await new Promise((resolve) => setTimeout(resolve, 5_400));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(sentProgress, [1, 2]);
    assert.equal(sendNotificationMock.mock.calls.length, 2);
  });

  it('suppresses progress after task execution is no longer reportable', async () => {
    const { createProgressReporter } = await import('../dist/lib/progress.js');
    const sendNotificationMock = mock.fn(async () => {});
    const onProgressMock = mock.fn();
    let canReport = true;

    const extra = {
      _meta: {
        progressToken: 'task-progress',
        'io.modelcontextprotocol/related-task': { taskId: 'task-123' },
      },
      sendNotification: sendNotificationMock,
      onProgress: onProgressMock,
      canReportProgress: () => canReport,
    } as unknown;

    const reporter = createProgressReporter(
      extra as Parameters<typeof createProgressReporter>[0]
    );

    reporter.report(1, 'Preparing request');
    canReport = false;
    reporter.report(8, 'Cancelled');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(onProgressMock.mock.calls.length, 1);
    assert.equal(sendNotificationMock.mock.calls.length, 1);
  });

  it('updates task status callbacks when the message changes at the same step', async () => {
    const { createProgressReporter } = await import('../dist/lib/progress.js');
    const onProgressMock = mock.fn();

    const reporter = createProgressReporter({
      onProgress: onProgressMock,
    });

    reporter.report(6, 'Parsing HTML -> Markdown');
    reporter.report(6, 'Preparing output');

    assert.equal(onProgressMock.mock.calls.length, 2);
    assert.deepEqual(onProgressMock.mock.calls[0]?.arguments, [
      6,
      'Parsing HTML -> Markdown',
    ]);
    assert.deepEqual(onProgressMock.mock.calls[1]?.arguments, [
      6,
      'Preparing output',
    ]);
  });
});
