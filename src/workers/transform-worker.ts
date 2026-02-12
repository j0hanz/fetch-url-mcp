import { parentPort } from 'node:worker_threads';

import { FetchError, getErrorMessage } from '../errors.js';
import { transformHtmlToMarkdownInProcess } from '../transform.js';

if (!parentPort) throw new Error('transform-worker started without parentPort');
const port = parentPort;

const controllersById = new Map<string, AbortController>();
const decoder = new TextDecoder('utf-8');

function postError(id: string, url: string, error: unknown): void {
  if (error instanceof FetchError) {
    port.postMessage({
      type: 'error',
      id,
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

  port.postMessage({
    type: 'error',
    id,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: getErrorMessage(error),
      url,
    },
  });
}

function isValidMessage(msg: Record<string, unknown>): msg is {
  id: string;
  url: string;
  html?: string;
  htmlBuffer?: Uint8Array;
  encoding?: string;
  includeMetadata: boolean;
  skipNoiseRemoval?: boolean;
  inputTruncated?: boolean;
} {
  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadata,
    skipNoiseRemoval,
    inputTruncated,
  } = msg;
  return (
    typeof id === 'string' &&
    typeof url === 'string' &&
    typeof includeMetadata === 'boolean' &&
    (html === undefined || typeof html === 'string') &&
    (htmlBuffer === undefined || htmlBuffer instanceof Uint8Array) &&
    (encoding === undefined || typeof encoding === 'string') &&
    (skipNoiseRemoval === undefined || typeof skipNoiseRemoval === 'boolean') &&
    (inputTruncated === undefined || typeof inputTruncated === 'boolean')
  );
}

function postValidationError(id: string, message: string, url: string): void {
  port.postMessage({
    type: 'error',
    id,
    error: { name: 'ValidationError', message, url },
  });
}

function decodeHtmlBuffer(htmlBuffer: Uint8Array, encoding?: string): string {
  if (!encoding || encoding === 'utf-8') {
    return decoder.decode(htmlBuffer);
  }
  try {
    return new TextDecoder(encoding).decode(htmlBuffer);
  } catch {
    // Fall back to UTF-8 when server-provided charset labels are invalid.
    return decoder.decode(htmlBuffer);
  }
}

function handleTransform(msg: Record<string, unknown>): void {
  if (!isValidMessage(msg)) return;

  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadata,
    skipNoiseRemoval,
    inputTruncated,
  } = msg;

  if (!id.trim()) {
    postValidationError(id, 'Missing transform message id', url || '');
    return;
  }

  if (!url.trim()) {
    postValidationError(id, 'Missing transform URL', url);
    return;
  }

  const controller = new AbortController();
  controllersById.set(id, controller);

  try {
    const content = htmlBuffer
      ? decodeHtmlBuffer(htmlBuffer, encoding)
      : (html ?? '');

    const result = transformHtmlToMarkdownInProcess(content, url, {
      includeMetadata,
      signal: controller.signal,
      ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
      ...(inputTruncated ? { inputTruncated: true } : {}),
    });

    const { markdown, metadata, title, truncated } = result;
    port.postMessage({
      type: 'result',
      id,
      result:
        title === undefined
          ? {
              markdown,
              ...(metadata ? { metadata } : {}),
              truncated,
            }
          : {
              markdown,
              ...(metadata ? { metadata } : {}),
              title,
              truncated,
            },
    });
  } catch (error: unknown) {
    postError(id, url, error);
  } finally {
    controllersById.delete(id);
  }
}

port.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const msg = raw as Record<string, unknown>;
  const { type, id } = msg;

  if (type === 'cancel') {
    if (typeof id !== 'string') return;
    const controller = controllersById.get(id);
    if (controller) controller.abort(new Error('Canceled'));
    port.postMessage({ type: 'cancelled', id });
    return;
  }

  if (type === 'transform') {
    handleTransform(msg);
  }
});
