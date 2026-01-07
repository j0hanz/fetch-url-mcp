import { parentPort } from 'node:worker_threads';

import type {
  MarkdownTransformResult,
  TransformOptions,
} from '../config/types/content.js';

import { isRecord } from '../utils/guards.js';

import { transformHtmlToMarkdownSync } from '../tools/utils/content-transform.js';

interface WorkerTransformRequest {
  id: number;
  html: string;
  url: string;
  options: TransformOptions;
}

type WorkerTransformResponse =
  | { id: number; ok: true; result: MarkdownTransformResult }
  | { id: number; ok: false; error: string };

const port = parentPort;

function isWorkerTransformRequest(
  value: unknown
): value is WorkerTransformRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.html === 'string' &&
    typeof value.url === 'string' &&
    typeof value.options === 'object'
  );
}

function handleMessage(value: unknown): void {
  if (!port) return;
  if (!isWorkerTransformRequest(value)) return;

  const { id, html, url, options } = value;

  try {
    const result = transformHtmlToMarkdownSync(html, url, options);

    const response: WorkerTransformResponse = {
      id,
      ok: true,
      result,
    };
    port.postMessage(response);
  } catch (error) {
    const response: WorkerTransformResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
}

if (!port) {
  process.exit(1);
}

port.on('message', handleMessage);
