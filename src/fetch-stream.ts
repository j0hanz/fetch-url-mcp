import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { FetchError } from './errors.js';
import { isObject } from './type-guards.js';

type CompatibleReadableStream = ReadableStream<Uint8Array> &
  NodeReadableStream<Uint8Array>;

function isReadableStreamLike(
  value: unknown
): value is CompatibleReadableStream {
  if (!isObject(value)) return false;

  return (
    typeof value['getReader'] === 'function' &&
    typeof value['cancel'] === 'function' &&
    typeof value['tee'] === 'function' &&
    typeof value['locked'] === 'boolean'
  );
}

function assertReadableStreamLike(
  stream: unknown,
  url: string,
  stage: string
): asserts stream is CompatibleReadableStream {
  if (isReadableStreamLike(stream)) return;
  throw new FetchError('Invalid response stream', url, 500, {
    reason: 'invalid_stream',
    stage,
  });
}

export function toNodeReadableStream(
  stream: ReadableStream<Uint8Array>,
  url: string,
  stage: string
): NodeReadableStream<Uint8Array> {
  assertReadableStreamLike(stream, url, stage);
  return stream;
}

export function toWebReadableStream(
  stream: Readable,
  url: string,
  stage: string
): ReadableStream<Uint8Array> {
  const converted: unknown = Readable.toWeb(stream);
  assertReadableStreamLike(converted, url, stage);
  return converted;
}
