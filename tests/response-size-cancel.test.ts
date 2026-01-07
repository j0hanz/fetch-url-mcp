import assert from 'node:assert/strict';
import test from 'node:test';

import { readResponseText } from '../dist/services/fetcher/response.js';

function createResponseWithTrackableBody(
  bodyText: string,
  headers?: HeadersInit
): {
  response: Response;
  cancelled: { value: boolean };
} {
  const cancelled = { value: false };

  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
    cancel() {
      cancelled.value = true;
    },
  });

  const response = new Response(tracked, { headers });
  return { response, cancelled };
}

function createResponseFromChunks(
  chunks: Uint8Array[],
  headers?: HeadersInit
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });

  return new Response(stream, { headers });
}

test('readResponseText cancels body when Content-Length exceeds maxBytes', async () => {
  const { response, cancelled } = createResponseWithTrackableBody('hello', {
    'content-length': '9999',
  });

  await assert.rejects(() =>
    readResponseText(
      response,
      'https://example.com',
      1,
      AbortSignal.timeout(5_000)
    )
  );

  assert.equal(cancelled.value, true);
});

test('readResponseText enforces maxBytes in the no-body text() fallback', async () => {
  const fakeResponse = {
    headers: new Headers(),
    body: null,
    text: async () => 'x'.repeat(10),
  } as unknown as Response;

  await assert.rejects(() =>
    readResponseText(fakeResponse, 'https://example.com', 1)
  );
});

test('readResponseText preserves UTF-8 decoding across chunk boundaries', async () => {
  // '€' is a 3-byte UTF-8 sequence: E2 82 AC.
  // Split it across chunks to validate TextDecoder streaming correctness.
  const response = createResponseFromChunks([
    new Uint8Array([0x61, 0xe2, 0x82]), // 'a' + first 2 bytes of '€'
    new Uint8Array([0xac, 0x62]), // last byte of '€' + 'b'
  ]);

  const result = await readResponseText(
    response,
    'https://example.com',
    10_000
  );
  assert.equal(result.text, 'a€b');
  assert.equal(result.size, 5);
});
