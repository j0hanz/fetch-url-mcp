import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { FetchError } from '../../errors/app-error.js';

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

  throw new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  type WritableChunk = string | Buffer | Uint8Array;
  const toBuffer = (chunk: WritableChunk): Buffer => {
    if (typeof chunk === 'string') {
      return Buffer.from(chunk);
    }

    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  };

  const sink = new Writable({
    write(
      chunk: WritableChunk,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ): void {
      const buffer = toBuffer(chunk);
      total += buffer.length;

      if (total > maxBytes) {
        callback(
          new FetchError(
            `Response exceeds maximum size of ${maxBytes} bytes`,
            url
          )
        );
        return;
      }

      text += decoder.decode(buffer, { stream: true });
      callback();
    },
    final(callback: (error?: Error | null) => void): void {
      text += decoder.decode();
      callback();
    },
  });

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

  return { text, size: total };
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
    return { text, size: Buffer.byteLength(text) };
  }

  return readStreamWithLimit(response.body, url, maxBytes, signal);
}
