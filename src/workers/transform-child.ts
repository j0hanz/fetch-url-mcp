import process from 'node:process';

import { FetchError, getErrorMessage } from '../errors.js';
import { transformHtmlToMarkdownInProcess } from '../transform.js';

const send = process.send?.bind(process);
if (!send) throw new Error('transform-child started without IPC channel');
const sendMessage = send as (message: Record<string, unknown>) => void;

function postMessage(message: Record<string, unknown>): void {
  sendMessage(message);
}

const controllersById = new Map<string, AbortController>();
const decoder = new TextDecoder('utf-8');

function postError(id: string, url: string, error: unknown): void {
  if (error instanceof FetchError) {
    postMessage({
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

  postMessage({
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
  if (typeof id !== 'string') return false;
  if (typeof url !== 'string') return false;
  if (typeof includeMetadata !== 'boolean') return false;
  if (html !== undefined && typeof html !== 'string') return false;
  if (htmlBuffer !== undefined && !(htmlBuffer instanceof Uint8Array))
    return false;
  if (encoding !== undefined && typeof encoding !== 'string') return false;
  if (skipNoiseRemoval !== undefined && typeof skipNoiseRemoval !== 'boolean')
    return false;
  if (inputTruncated !== undefined && typeof inputTruncated !== 'boolean')
    return false;
  return true;
}

function postValidationError(id: string, url: string, message: string): void {
  postMessage({
    type: 'error',
    id,
    error: { name: 'ValidationError', message, url },
  });
}

function decodeHtml(
  html: string | undefined,
  htmlBuffer: Uint8Array | undefined,
  encoding: string | undefined
): string {
  if (!htmlBuffer) return html ?? '';
  if (!encoding || encoding === 'utf-8') return decoder.decode(htmlBuffer);
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
    postValidationError(id, url || '', 'Missing transform message id');
    return;
  }

  if (!url.trim()) {
    postValidationError(id, url, 'Missing transform URL');
    return;
  }

  const controller = new AbortController();
  controllersById.set(id, controller);

  try {
    const content = decodeHtml(html, htmlBuffer, encoding);

    const result = transformHtmlToMarkdownInProcess(content, url, {
      includeMetadata,
      signal: controller.signal,
      ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
      ...(inputTruncated ? { inputTruncated: true } : {}),
    });

    const { markdown, metadata, title, truncated } = result;
    postMessage({
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

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const msg = raw as Record<string, unknown>;
  const { type, id } = msg;

  if (type === 'cancel') {
    if (typeof id !== 'string') return;
    const controller = controllersById.get(id);
    if (controller) controller.abort(new Error('Canceled'));
    postMessage({ type: 'cancelled', id });
    return;
  }

  if (type === 'transform') {
    handleTransform(msg);
  }
});
