import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchNormalizedUrl } from '../dist/fetch.js';
import { dispatcher as expectedDispatcher } from '../dist/fetch.js';

test('fetch pipeline always passes the undici dispatcher into fetch()', async () => {
  const originalFetch: typeof fetch = fetch;

  let called = false;
  const mockedFetch: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    void input;
    called = true;

    assert.ok(init);
    assert.equal(
      (init as RequestInit & { dispatcher?: unknown }).dispatcher,
      expectedDispatcher
    );
    assert.equal(init.redirect, 'manual');

    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  try {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      mockedFetch;

    const text = await fetchNormalizedUrl('https://example.com');

    assert.equal(text, 'ok');
    assert.equal(called, true);
  } finally {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  }
});
