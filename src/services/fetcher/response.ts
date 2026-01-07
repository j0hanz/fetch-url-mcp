import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { FetchError } from '../../errors/app-error.js';

type WritableChunk = string | Buffer | Uint8Array;

function assertContentLengthWithinLimit(
  response: Response,
  url: string,
  maxBytes: number
): void {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) return;
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (Number.isNaN(contentLength) || contentLength <= maxBytes) {
    return;
  }

  void response.body?.cancel();

  throw new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

interface StreamReadState {
  decoder: TextDecoder;
  parts: string[];
  total: number;
}

function createReadState(): StreamReadState {
  return {
    decoder: new TextDecoder(),
    parts: [],
    total: 0,
  };
}

function toBuffer(chunk: WritableChunk): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function appendChunk(
  state: StreamReadState,
  chunk: WritableChunk,
  maxBytes: number,
  url: string
): void {
  const buffer = toBuffer(chunk);
  state.total += buffer.length;

  if (state.total > maxBytes) {
    throw new FetchError(
      `Response exceeds maximum size of ${maxBytes} bytes`,
      url
    );
  }

  const decoded = state.decoder.decode(buffer, { stream: true });
  if (decoded) state.parts.push(decoded);
}

function finalizeRead(state: StreamReadState): void {
  const decoded = state.decoder.decode();
  if (decoded) state.parts.push(decoded);
}

function createLimitedSink(
  state: StreamReadState,
  maxBytes: number,
  url: string
): Writable {
  return new Writable({
    write(
      chunk: WritableChunk,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ): void {
      try {
        appendChunk(state, chunk, maxBytes, url);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    final(callback: (error?: Error | null) => void): void {
      finalizeRead(state);
      callback();
    },
  });
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  const state = createReadState();
  const sink = createLimitedSink(state, maxBytes, url);

  try {
    const readable = Readable.fromWeb(stream as WebReadableStream, { signal });
    await pipeline(readable, sink, { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw new FetchError(
        'Request was aborted during response read',
        url,
        499,
        { reason: 'aborted' }
      );
    }
    throw error;
  }

  return { text: state.parts.join(''), size: state.total };
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  assertContentLengthWithinLimit(response, url, maxBytes);

  if (!response.body) {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    if (size > maxBytes) {
      throw new FetchError(
        `Response exceeds maximum size of ${maxBytes} bytes`,
        url
      );
    }
    return { text, size };
  }

  return readStreamWithLimit(response.body, url, maxBytes, signal);
}
