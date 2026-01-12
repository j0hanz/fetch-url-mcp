import { parentPort } from 'node:worker_threads';

import { FetchError, getErrorMessage } from '../errors.js';
import { transformHtmlToMarkdownInProcess } from '../transform.js';

interface TransformMessage {
  type: 'transform';
  id: string;
  html: string;
  url: string;
  includeMetadata: boolean;
}

interface CancelMessage {
  type: 'cancel';
  id: string;
}

interface WorkerResultMessage {
  type: 'result';
  id: string;
  result: { markdown: string; title?: string; truncated: boolean };
}

interface WorkerErrorMessage {
  type: 'error';
  id: string;
  error: {
    name: string;
    message: string;
    url: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
}

const controllers = new Map<string, AbortController>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function post(message: WorkerResultMessage | WorkerErrorMessage): void {
  parentPort?.postMessage(message);
}

function handleTransform(message: TransformMessage): void {
  const controller = new AbortController();
  controllers.set(message.id, controller);

  try {
    const result = transformHtmlToMarkdownInProcess(message.html, message.url, {
      includeMetadata: message.includeMetadata,
      signal: controller.signal,
    });

    post({
      type: 'result',
      id: message.id,
      result: {
        markdown: result.markdown,
        ...(result.title === undefined ? {} : { title: result.title }),
        truncated: result.truncated,
      },
    });
  } catch (error: unknown) {
    if (error instanceof FetchError) {
      post({
        type: 'error',
        id: message.id,
        error: {
          name: error.name,
          message: error.message,
          url: error.url,
          statusCode: error.statusCode,
          details: { ...error.details },
        },
      });
      return;
    }

    post({
      type: 'error',
      id: message.id,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: getErrorMessage(error),
        url: message.url,
      },
    });
  } finally {
    controllers.delete(message.id);
  }
}

function handleCancel(message: CancelMessage): void {
  const controller = controllers.get(message.id);
  if (!controller) return;
  controller.abort(new Error('Canceled'));
}

if (!parentPort) {
  throw new Error('transform-worker started without parentPort');
}

parentPort.on('message', (raw: unknown) => {
  if (!isRecord(raw)) return;

  const { type } = raw;

  if (type === 'cancel') {
    if (typeof raw.id !== 'string') return;
    handleCancel({ type: 'cancel', id: raw.id });
    return;
  }

  if (type === 'transform') {
    if (typeof raw.id !== 'string') return;
    if (typeof raw.html !== 'string') return;
    if (typeof raw.url !== 'string') return;
    if (typeof raw.includeMetadata !== 'boolean') return;
    handleTransform({
      type: 'transform',
      id: raw.id,
      html: raw.html,
      url: raw.url,
      includeMetadata: raw.includeMetadata,
    });
  }
});
