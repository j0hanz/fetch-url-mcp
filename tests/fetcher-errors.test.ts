import assert from 'node:assert/strict';
import dns from 'node:dns';
import test from 'node:test';

import { FetchError } from '../dist/lib/errors.js';
import { fetchNormalizedUrl } from '../dist/lib/fetch.js';

test('fetchNormalizedUrl throws rate limit error on 429', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response('busy', {
      status: 429,
      headers: { 'retry-after': '30' },
    });
  });

  await assert.rejects(
    () => fetchNormalizedUrl('https://example.com'),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.details.retryAfter, 30);
      return true;
    }
  );
});

test('fetchNormalizedUrl throws http error on non-OK response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response('error', { status: 500, statusText: 'Server Error' });
  });

  await assert.rejects(
    () => fetchNormalizedUrl('https://example.com'),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.statusCode, 500);
      assert.ok(error.message.includes('HTTP 500: Server Error'));
      return true;
    }
  );
});

test('fetchNormalizedUrl maps network failures to FetchError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Network down');
  });

  await assert.rejects(
    () => fetchNormalizedUrl('https://example.com'),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.statusCode, 502);
      assert.ok(error.message.includes('Network error'));
      return true;
    }
  );
});

test('fetchNormalizedUrl rejects unsupported content types', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '3',
      },
    });
  });

  await assert.rejects(
    () => fetchNormalizedUrl('https://example.com'),
    (error: unknown) => {
      assert.ok(error instanceof FetchError);
      assert.equal(error.message, 'Unsupported content type: image/png');
      return true;
    }
  );
});

test('fetchNormalizedUrl rejects non-text application content types', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '3',
      },
    });
  });

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
});

test('fetchNormalizedUrl aborts during DNS preflight', async (t) => {
  const controller = new AbortController();
  controller.abort();

  t.mock.method(dns.promises, 'lookup', async () => {
    return await new Promise<never>(() => {
      // Never resolves; abort should win.
    });
  });
  t.mock.method(dns.promises, 'resolveCname', async () => []);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called');
  });

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
});

test('fetchNormalizedUrl aborts during redirect DNS preflight', async (t) => {
  const controller = new AbortController();

  const originalLookup = dns.promises.lookup;
  t.mock.method(
    dns.promises,
    'lookup',
    async (hostname: string, options?: dns.LookupOptions | number) => {
      if (hostname === 'example.com') {
        return [{ address: '93.184.216.34', family: 4 }];
      }

      if (hostname === 'redirected.test') {
        await new Promise<never>(() => {
          // Never resolves; abort should win if signal is threaded.
        });
      }

      if (options === undefined) {
        return await originalLookup(hostname);
      }

      if (typeof options === 'number') {
        return await originalLookup(hostname, { family: options });
      }

      return await originalLookup(hostname, options);
    }
  );
  t.mock.method(dns.promises, 'resolveCname', async () => []);
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
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
  });

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
});

test('fetchNormalizedUrl ignores DNS CNAME timeout failures and continues', async (t) => {
  t.mock.method(dns.promises, 'resolveCname', async () => {
    throw Object.assign(new Error('DNS CNAME lookup timed out'), {
      code: 'ETIMEOUT',
    });
  });
  t.mock.method(dns.promises, 'lookup', async () => {
    return [{ address: '93.184.216.34', family: 4 }];
  });
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  });

  const result = await fetchNormalizedUrl('https://example.com');
  assert.equal(result, 'ok');
});

test('fetchNormalizedUrl ignores no-data CNAME errors and continues', async (t) => {
  t.mock.method(dns.promises, 'resolveCname', async () => {
    throw Object.assign(new Error('No CNAME records'), { code: 'ENODATA' });
  });
  t.mock.method(dns.promises, 'lookup', async () => {
    return [{ address: '93.184.216.34', family: 4 }];
  });
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  });

  const result = await fetchNormalizedUrl('https://example.com');
  assert.equal(result, 'ok');
});
