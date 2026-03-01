import { FetchError, getErrorMessage } from '../../lib/utils.js';
import type {
  MarkdownTransformResult,
  TransformOptions,
  TransformWorkerOutgoingMessage,
  TransformWorkerTransformMessage,
} from '../types.js';

interface WorkerMessageHandlerOptions {
  sendMessage: (message: TransformWorkerOutgoingMessage) => void;
  runTransform: (
    html: string,
    url: string,
    options: TransformOptions
  ) => MarkdownTransformResult;
}

type IncomingMessageRecord = Record<string, unknown>;

function isTransformMessage(
  message: unknown
): message is TransformWorkerTransformMessage {
  if (!message || typeof message !== 'object') return false;

  const value = message as IncomingMessageRecord;
  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadata,
    skipNoiseRemoval,
    inputTruncated,
  } = value;

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

function decodeHtml(
  html: string | undefined,
  htmlBuffer: Uint8Array | undefined,
  encoding: string | undefined,
  decoder: TextDecoder
): string {
  if (!htmlBuffer) return html ?? '';

  if (!encoding || encoding === 'utf-8') {
    return decoder.decode(htmlBuffer);
  }

  try {
    return new TextDecoder(encoding).decode(htmlBuffer);
  } catch {
    return decoder.decode(htmlBuffer);
  }
}

function createErrorMessage(
  id: string,
  url: string,
  error: unknown
): TransformWorkerOutgoingMessage {
  if (error instanceof FetchError) {
    return {
      type: 'error',
      id,
      error: {
        name: error.name,
        message: error.message,
        url: error.url,
        statusCode: error.statusCode,
        details: { ...error.details },
      },
    };
  }

  return {
    type: 'error',
    id,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: getErrorMessage(error),
      url,
    },
  };
}

function createResultMessage(
  id: string,
  result: MarkdownTransformResult
): TransformWorkerOutgoingMessage {
  return {
    type: 'result',
    id,
    result: {
      markdown: result.markdown,
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      truncated: result.truncated,
    },
  };
}

export function createTransformMessageHandler(
  options: WorkerMessageHandlerOptions
): (raw: unknown) => void {
  const { sendMessage, runTransform } = options;
  const controllersById = new Map<string, AbortController>();
  const decoder = new TextDecoder('utf-8');

  return (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;

    const message = raw as IncomingMessageRecord;
    const messageType = message['type'];
    const messageId = message['id'];

    if (messageType === 'cancel') {
      if (typeof messageId !== 'string') return;

      const controller = controllersById.get(messageId);
      if (controller) controller.abort(new Error('Canceled'));

      sendMessage({ type: 'cancelled', id: messageId });
      return;
    }

    if (messageType !== 'transform' || !isTransformMessage(message)) return;

    const {
      id,
      url,
      html,
      htmlBuffer,
      encoding,
      includeMetadata,
      skipNoiseRemoval,
      inputTruncated,
    } = message;

    if (!id.trim()) {
      sendMessage({
        type: 'error',
        id,
        error: {
          name: 'ValidationError',
          message: 'Missing transform message id',
          url: url || '',
        },
      });
      return;
    }

    if (!url.trim()) {
      sendMessage({
        type: 'error',
        id,
        error: {
          name: 'ValidationError',
          message: 'Missing transform URL',
          url,
        },
      });
      return;
    }

    const controller = new AbortController();
    controllersById.set(id, controller);

    try {
      const content = decodeHtml(html, htmlBuffer, encoding, decoder);
      const result = runTransform(content, url, {
        includeMetadata,
        signal: controller.signal,
        ...(skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
        ...(inputTruncated ? { inputTruncated: true } : {}),
      });

      sendMessage(createResultMessage(id, result));
    } catch (error: unknown) {
      sendMessage(createErrorMessage(id, url, error));
    } finally {
      controllersById.delete(id);
    }
  };
}
