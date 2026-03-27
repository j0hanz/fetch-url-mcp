import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { createCacheKey, set, toCacheScopeId } from '../src/lib/cache.js';
import {
  isCacheEntryVisibleToScope,
  listCacheResourcesForScope,
  readCacheResourceForScope,
} from '../src/resources/index.js';
import { stringifyCachedPayload } from '../src/schemas.js';

describe('cache resource scope visibility', () => {
  it('hides cache resources from other session scopes', () => {
    const namespace = `scope-${randomUUID()}`;
    const scopeA = toCacheScopeId('session-a');
    const scopeB = toCacheScopeId('session-b');
    const cacheKey = createCacheKey(namespace, 'https://example.com/a');

    assert.ok(cacheKey);

    set(cacheKey, stringifyCachedPayload({ markdown: '# A' }), {
      url: 'https://example.com/a',
      title: 'A',
      scopeIds: [scopeA],
    });

    const visibleToA = listCacheResourcesForScope(scopeA).resources;
    const visibleToB = listCacheResourcesForScope(scopeB).resources;

    assert.equal(visibleToA.length, 1);
    assert.equal(visibleToB.length, 0);
  });

  it('reads cache resource only for visible scope', () => {
    const namespace = `scope-${randomUUID()}`;
    const scopeId = toCacheScopeId('session-c');
    const otherScopeId = toCacheScopeId('session-d');
    const cacheKey = createCacheKey(namespace, 'https://example.com/b');

    assert.ok(cacheKey);

    set(cacheKey, stringifyCachedPayload({ markdown: '# B' }), {
      url: 'https://example.com/b',
      title: 'B',
      scopeIds: [scopeId],
    });

    const result = readCacheResourceForScope(
      new URL(`internal://cache/${namespace}/${cacheKey.split(':')[1]}`),
      {},
      scopeId
    );

    const content = result.contents[0];
    assert.ok(content && 'text' in content);
    assert.equal(content.text, '# B');
    assert.throws(
      () =>
        readCacheResourceForScope(
          new URL(`internal://cache/${namespace}/${cacheKey.split(':')[1]}`),
          {},
          otherScopeId
        ),
      (error: unknown) => error instanceof Error
    );
  });

  it('matches scope visibility against scopeIds', () => {
    assert.equal(
      isCacheEntryVisibleToScope(toCacheScopeId('session-e'), {
        scopeIds: [toCacheScopeId('session-e')],
      }),
      true
    );
    assert.equal(
      isCacheEntryVisibleToScope(toCacheScopeId('session-f'), {
        scopeIds: [toCacheScopeId('session-g')],
      }),
      false
    );
  });
});
