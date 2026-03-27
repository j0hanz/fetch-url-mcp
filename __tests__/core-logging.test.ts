import assert from 'node:assert/strict';
import process from 'node:process';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  config,
  logInfo,
  registerMcpSessionServer,
  runWithRequestContext,
  setLogLevel,
  setMcpServer,
  unregisterMcpSessionServer,
} from '../src/lib/core.js';

interface CapturedLog {
  payload: {
    level: string;
    logger: string;
    data: Record<string, unknown>;
  };
  sessionId?: string;
}

const capturedLogs: CapturedLog[] = [];
const fakeServer = {
  isConnected: () => true,
  server: {
    sendLoggingMessage: (
      payload: CapturedLog['payload'],
      sessionId?: string
    ): Promise<void> => {
      capturedLogs.push({ payload, ...(sessionId ? { sessionId } : {}) });
      return Promise.resolve();
    },
  },
} as unknown as McpServer;

function createSilentWrite(): typeof process.stderr.write {
  return ((...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === 'function');
    if (typeof callback === 'function') callback();
    return true;
  }) as typeof process.stderr.write;
}

describe('core logging MCP forwarding', () => {
  const originalLevel = config.logging.level;
  const originalFormat = config.logging.format;
  const originalWrite = process.stderr.write;

  before(() => {
    setMcpServer(fakeServer);
    process.stderr.write = createSilentWrite();
  });

  after(() => {
    config.logging.level = originalLevel;
    config.logging.format = originalFormat;
    setLogLevel(originalLevel);
    process.stderr.write = originalWrite;
  });

  beforeEach(() => {
    capturedLogs.length = 0;
    config.logging.format = 'text';
    config.logging.level = 'info';
    setLogLevel('debug');
    unregisterMcpSessionServer('sess-1');
    unregisterMcpSessionServer('sess-2');
  });

  it('forwards merged request context and strips sensitive metadata', () => {
    config.logging.level = 'debug';
    setLogLevel('debug');
    registerMcpSessionServer('sess-1', fakeServer);

    runWithRequestContext(
      {
        requestId: 'req-1',
        operationId: 'op-1',
        sessionId: 'sess-1',
      },
      () => {
        logInfo(
          'fetch complete',
          {
            url: 'https://example.com/docs',
            message: 'inner-message',
            password: 'secret',
            nested: {
              authorization: 'Bearer secret-token',
              keep: 'value',
            },
            stack: 'secret stack trace',
          },
          'fetch-url'
        );
      }
    );

    assert.equal(capturedLogs.length, 1);
    assert.equal(capturedLogs[0]?.sessionId, 'sess-1');
    assert.equal(capturedLogs[0]?.payload.level, 'info');
    assert.equal(capturedLogs[0]?.payload.logger, 'fetch-url');
    assert.deepEqual(capturedLogs[0]?.payload.data, {
      requestId: 'req-1',
      operationId: 'op-1',
      sessionId: 'sess-1',
      url: 'https://example.com/docs',
      nested: { keep: 'value' },
      _message: 'inner-message',
      message: 'fetch complete',
    });
  });

  it('omits sessionId from forwarded metadata when debug logging is disabled', () => {
    config.logging.level = 'info';
    setLogLevel('debug');
    registerMcpSessionServer('sess-2', fakeServer);

    runWithRequestContext(
      {
        requestId: 'req-2',
        operationId: 'op-2',
        sessionId: 'sess-2',
      },
      () => {
        logInfo('fetch complete', { url: 'https://example.com' }, 'fetch-url');
      }
    );

    assert.equal(capturedLogs.length, 1);
    assert.deepEqual(capturedLogs[0]?.payload.data, {
      requestId: 'req-2',
      operationId: 'op-2',
      url: 'https://example.com',
      message: 'fetch complete',
    });
    assert.equal(capturedLogs[0]?.sessionId, 'sess-2');
  });
});
