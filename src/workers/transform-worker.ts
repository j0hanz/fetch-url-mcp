import { parentPort } from 'node:worker_threads';

import type {
  JsonlTransformResult,
  MarkdownTransformResult,
  TransformOptions,
} from '../config/types/content.js';

import {
  transformHtmlToJsonl,
  transformHtmlToMarkdown,
  transformHtmlToMarkdownWithBlocks,
} from '../tools/utils/content-transform.js';

type TransformMode = 'jsonl' | 'markdown' | 'markdown-blocks';

interface TransformJob {
  id: number;
  mode: TransformMode;
  html: string;
  url: string;
  options: TransformOptions & {
    includeContentBlocks?: boolean;
  };
}

type TransformResult = JsonlTransformResult | MarkdownTransformResult;

type TransformResponse =
  | { id: number; ok: true; result: TransformResult }
  | { id: number; ok: false; error: string };

function isTransformJob(value: unknown): value is TransformJob {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'number' &&
    typeof record.mode === 'string' &&
    typeof record.html === 'string' &&
    typeof record.url === 'string'
  );
}

function resolveTransform(
  job: TransformJob
): JsonlTransformResult | MarkdownTransformResult {
  if (job.mode === 'markdown') {
    return transformHtmlToMarkdown(job.html, job.url, job.options);
  }

  if (job.mode === 'markdown-blocks') {
    return transformHtmlToMarkdownWithBlocks(job.html, job.url, {
      ...job.options,
      includeContentBlocks: job.options.includeContentBlocks ?? true,
    });
  }

  return transformHtmlToJsonl(job.html, job.url, job.options);
}

function sendResponse(response: TransformResponse): void {
  if (!parentPort) return;
  parentPort.postMessage(response);
}

function handleMessage(message: unknown): void {
  if (!isTransformJob(message)) {
    sendResponse({
      id: -1,
      ok: false,
      error: 'Invalid transform job payload',
    });
    return;
  }

  try {
    const result = resolveTransform(message);
    sendResponse({ id: message.id, ok: true, result });
  } catch (error) {
    sendResponse({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort?.on('message', handleMessage);
