import assert from 'node:assert/strict';
import dns from 'node:dns';
import test from 'node:test';

import { FetchError } from '../dist/errors.js';
import { fetchNormalizedUrl } from '../dist/fetch.js';

function withMockedFetch(
  mock: typeof fetch,
  execute: () => Promise<void>
): Promise<void> {
  const originalFetch: typeof fetch = fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock;

  return execute().finally(() => {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  });
}

test('fetchNormalizedUrl throws rate limit error on 429', async () => {
  await withMockedFetch(
    async () => {
      return new Response('busy', {
        status: 429,
        headers: { 'retry-after': '30' },
      });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 429);
          assert.equal(error.details.retryAfter, 30);
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl throws http error on non-OK response', async () => {
  await withMockedFetch(
    async () => {
      return new Response('error', { status: 500, statusText: 'Server Error' });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 500);
          assert.ok(error.message.includes('HTTP 500: Server Error'));
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl maps network failures to FetchError', async () => {
  await withMockedFetch(
    async () => {
      throw new TypeError('Network down');
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.statusCode, 502);
          assert.ok(error.message.includes('Network error'));
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl rejects unsupported content types', async () => {
  await withMockedFetch(
    async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '3',
        },
      });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(error.message, 'Unsupported content type: image/png');
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl rejects non-text application content types', async () => {
  await withMockedFetch(
    async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '3',
        },
      });
    },
    async () => {
      await assert.rejects(
        () => fetchNormalizedUrl('https://example.com'),
        (error: unknown) => {
          assert.ok(error instanceof FetchError);
          assert.equal(
            error.message,
            'Unsupported content type: application/octet-stream'
          );
          return true;
        }
      );
    }
  );
});

test('fetchNormalizedUrl aborts during DNS preflight', async () => {
  const controller = new AbortController();
  controller.abort();

  const originalLookup = dns.promises.lookup;
  const originalResolveCname = dns.promises.resolveCname;
  dns.promises.lookup = async () =>
    await new Promise(() => {
      // Never resolves; abort should win.
    });
  dns.promises.resolveCname = async () => [];

  const originalFetch: typeof fetch = fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
    async () => {
      throw new Error('fetch should not be called');
    };

  try {
    await assert.rejects(
      () =>
        fetchNormalizedUrl('https://example.com', {
          signal: controller.signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 499);
        return true;
      }
    );
  } finally {
    dns.promises.lookup = originalLookup;
    dns.promises.resolveCname = originalResolveCname;
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  }
});

test('fetchNormalizedUrl aborts during redirect DNS preflight', async () => {
  const controller = new AbortController();

  const originalLookup = dns.promises.lookup;
  const originalResolveCname = dns.promises.resolveCname;
  dns.promises.lookup = async (hostname, _options) => {
    if (hostname === 'example.com') {
      return [{ address: '93.184.216.34', family: 4 }];
    }

    if (hostname === 'redirected.test') {
      await new Promise(() => {
        // Never resolves; abort should win if signal is threaded.
      });
    }

    return await originalLookup(hostname, _options);
  };
  dns.promises.resolveCname = async () => [];

  const originalFetch: typeof fetch = fetch;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (
    url
  ) => {
    if (String(url).includes('example.com')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://redirected.test/resource' },
      });
    }

    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    setTimeout(() => controller.abort(), 10);

    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('test-timeout'));
      }, 200);
    });

    await assert.rejects(
      Promise.race([
        fetchNormalizedUrl('https://example.com/start', {
          signal: controller.signal,
        }),
        timeout,
      ]),
      (error: unknown) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 499);
        return true;
      }
    );
  } finally {
    dns.promises.lookup = originalLookup;
    dns.promises.resolveCname = originalResolveCname;
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      originalFetch;
  }
});
