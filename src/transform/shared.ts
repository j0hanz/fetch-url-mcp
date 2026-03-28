import { FetchError, getErrorMessage } from '../lib/error/index.js';

import type {
  MarkdownTransformResult,
  TransformOptions,
  TransformWorkerOutgoingMessage,
  TransformWorkerTransformMessage,
} from './types.js';

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
    includeMetadataFooter,
    inputTruncated,
  } = value;

  return (
    typeof id === 'string' &&
    typeof url === 'string' &&
    typeof includeMetadataFooter === 'boolean' &&
    (html === undefined || typeof html === 'string') &&
    (htmlBuffer === undefined || htmlBuffer instanceof Uint8Array) &&
    (encoding === undefined || typeof encoding === 'string') &&
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
    const decoded = new TextDecoder(encoding).decode(htmlBuffer);
    return decoded;
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

function createValidationErrorMessage(
  id: string,
  url: string,
  message: string
): TransformWorkerOutgoingMessage {
  return {
    type: 'error',
    id,
    error: {
      name: 'ValidationError',
      message,
      url,
    },
  };
}

function handleCancelMessage(params: {
  id: string;
  controllersById: Map<string, AbortController>;
  sendMessage: (message: TransformWorkerOutgoingMessage) => void;
}): void {
  const controller = params.controllersById.get(params.id);
  if (controller) controller.abort(new Error('Canceled'));

  params.sendMessage({ type: 'cancelled', id: params.id });
}

function executeTransformMessage(params: {
  message: TransformWorkerTransformMessage;
  controllersById: Map<string, AbortController>;
  decoder: TextDecoder;
  runTransform: WorkerMessageHandlerOptions['runTransform'];
  sendMessage: WorkerMessageHandlerOptions['sendMessage'];
}): void {
  const { message, controllersById, decoder, runTransform, sendMessage } =
    params;
  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadataFooter,
    inputTruncated,
  } = message;

  if (!id.trim()) {
    sendMessage(
      createValidationErrorMessage(
        id,
        url || '',
        'Missing transform message id'
      )
    );
    return;
  }

  if (!url.trim()) {
    sendMessage(createValidationErrorMessage(id, url, 'Missing transform URL'));
    return;
  }

  const controller = new AbortController();
  controllersById.set(id, controller);

  try {
    const content = decodeHtml(html, htmlBuffer, encoding, decoder);
    const result = runTransform(content, url, {
      includeMetadataFooter,
      signal: controller.signal,
      ...(inputTruncated ? { inputTruncated: true } : {}),
    });

    sendMessage(createResultMessage(id, result));
  } catch (error: unknown) {
    sendMessage(createErrorMessage(id, url, error));
  } finally {
    controllersById.delete(id);
  }
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
      handleCancelMessage({ id: messageId, controllersById, sendMessage });
      return;
    }

    if (messageType !== 'transform' || !isTransformMessage(message)) return;
    executeTransformMessage({
      message,
      controllersById,
      decoder,
      runTransform,
      sendMessage,
    });
  };
}
