import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCachedMarkdownResult } from '../dist/lib/fetch-pipeline.js';

describe('parseCachedMarkdownResult', () => {
  it('accepts cached payload with markdown field', () => {
    const cached = JSON.stringify({ markdown: '# Hello', title: 'T' });
    const parsed = parseCachedMarkdownResult(cached);

    assert.ok(parsed);
    assert.equal(parsed.content, '# Hello');
    assert.equal(parsed.markdown, '# Hello');
    assert.equal(parsed.title, 'T');
    assert.equal(parsed.truncated, false);
  });

  it('rejects invalid JSON', () => {
    const parsed = parseCachedMarkdownResult('{');
    assert.equal(parsed, undefined);
  });

  it('rejects payloads without string markdown', () => {
    const parsed = parseCachedMarkdownResult(JSON.stringify({ markdown: 123 }));
    assert.equal(parsed, undefined);
  });
});
