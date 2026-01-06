import { parentPort } from 'node:worker_threads';

import type {
  JsonlTransformResult,
  MarkdownTransformResult,
  TransformOptions,
} from '../config/types/content.js';

import {
  transformHtmlToJsonlSync,
  transformHtmlToMarkdownSync,
  transformHtmlToMarkdownWithBlocksSync,
} from '../tools/utils/content-transform.js';

type TransformKind = 'jsonl' | 'markdown' | 'markdown-with-blocks';

type WorkerTransformOptions = TransformOptions & {
  includeContentBlocks?: boolean;
};

interface WorkerTransformRequest {
  id: number;
  kind: TransformKind;
  html: string;
  url: string;
  options: WorkerTransformOptions;
}

type WorkerTransformResult = JsonlTransformResult | MarkdownTransformResult;

type WorkerTransformResponse =
  | { id: number; ok: true; result: WorkerTransformResult }
  | { id: number; ok: false; error: string };

const port = parentPort;

function isWorkerTransformRequest(
  value: unknown
): value is WorkerTransformRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'number' &&
    typeof record.kind === 'string' &&
    typeof record.html === 'string' &&
    typeof record.url === 'string' &&
    typeof record.options === 'object'
  );
}

function handleMessage(value: unknown): void {
  if (!port) return;
  if (!isWorkerTransformRequest(value)) return;

  const { id, kind, html, url, options } = value;

  try {
    let result: WorkerTransformResult;
    if (kind === 'markdown') {
      result = transformHtmlToMarkdownSync(html, url, options);
    } else if (kind === 'markdown-with-blocks') {
      result = transformHtmlToMarkdownWithBlocksSync(html, url, options);
    } else {
      result = transformHtmlToJsonlSync(html, url, options);
    }

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
