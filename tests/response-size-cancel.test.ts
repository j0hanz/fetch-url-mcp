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
