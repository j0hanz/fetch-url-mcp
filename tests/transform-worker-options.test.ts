import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import { config } from '../dist/lib/core.js';
import {
  shutdownTransformWorkerPool,
  transformBufferToMarkdown,
} from '../dist/transform/transform.js';

type WorkerMode = 'threads' | 'process';

const originalWorkerMode = config.transform.workerMode;
const originalMaxWorkerScale = config.transform.maxWorkerScale;
const encoder = new TextEncoder();

async function withTransformWorkerConfig<T>(
  mode: WorkerMode,
  maxWorkerScale: number,
  fn: () => Promise<T>
): Promise<T> {
  config.transform.workerMode = mode;
  config.transform.maxWorkerScale = maxWorkerScale;
  await shutdownTransformWorkerPool();

  try {
    return await fn();
  } finally {
    await shutdownTransformWorkerPool();
    config.transform.workerMode = originalWorkerMode;
    config.transform.maxWorkerScale = originalMaxWorkerScale;
  }
}

describe('transform worker options', () => {
  after(async () => {
    await shutdownTransformWorkerPool();
    config.transform.workerMode = originalWorkerMode;
    config.transform.maxWorkerScale = originalMaxWorkerScale;
  });

  it('propagates inputTruncated in thread worker mode', async () => {
    await withTransformWorkerConfig('threads', 2, async () => {
      const htmlBuffer = encoder.encode(
        '<html><body><p>Hello</p></body></html>'
      );
      const result = await transformBufferToMarkdown(
        htmlBuffer,
        'https://example.com/thread-worker',
        {
          includeMetadata: false,
          inputTruncated: true,
        }
      );

      assert.equal(result.truncated, true);
      assert.ok(result.markdown.includes('Hello'));
    });
  });

  it('propagates inputTruncated in process worker mode', async () => {
    await withTransformWorkerConfig('process', 2, async () => {
      const htmlBuffer = encoder.encode(
        '<html><body><p>Process worker</p></body></html>'
      );
      const result = await transformBufferToMarkdown(
        htmlBuffer,
        'https://example.com/process-worker',
        {
          includeMetadata: false,
          inputTruncated: true,
        }
      );

      assert.equal(result.truncated, true);
      assert.ok(result.markdown.includes('Process worker'));
    });
  });

  it('keeps inputTruncated for in-process raw markdown fallback', async () => {
    await withTransformWorkerConfig('threads', 0, async () => {
      const markdownBuffer = encoder.encode('# Header\n\ncontent');
      const result = await transformBufferToMarkdown(
        markdownBuffer,
        'https://example.com/readme.md',
        {
          includeMetadata: false,
          inputTruncated: true,
        }
      );

      assert.equal(result.truncated, true);
      assert.ok(result.markdown.includes('# Header'));
    });
  });

  it('falls back to in-process transform when worker dispatch fails', async (t) => {
    await withTransformWorkerConfig('threads', 1, async () => {
      t.mock.method(Worker.prototype, 'postMessage', () => {
        throw new Error('forced worker dispatch failure');
      });

      const htmlBuffer = encoder.encode(
        '<html><body><p>worker fallback</p></body></html>'
      );
      const result = await transformBufferToMarkdown(
        htmlBuffer,
        'https://example.com/worker-dispatch-failure',
        {
          includeMetadata: false,
        }
      );

      assert.ok(result.markdown.includes('worker fallback'));
    });
  });
});
