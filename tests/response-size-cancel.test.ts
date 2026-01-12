import assert from 'node:assert/strict';
import test from 'node:test';

import { readResponseText } from '../dist/fetch.js';

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
  // '\u20ac' is a 3-byte UTF-8 sequence: E2 82 AC.
  // Split it across chunks to validate TextDecoder streaming correctness.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x61, 0xe2, 0x82]));
      controller.enqueue(new Uint8Array([0xac, 0x62]));
      controller.close();
    },
  });
  const response = new Response(stream);

  const result = await readResponseText(
    response,
    'https://example.com',
    10_000
  );
  assert.equal(result.text, 'a\u20acb');
  assert.equal(result.size, 5);
});

test('readResponseText rejects with an abort error when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('hello'));
      streamController.close();
    },
  });
  const response = new Response(stream);

  await assert.rejects(
    () =>
      readResponseText(
        response,
        'https://example.com',
        10_000,
        controller.signal
      ),
    { message: /aborted/i }
  );
});
