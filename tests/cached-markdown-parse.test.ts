import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCachedMarkdownResult } from '../dist/tools.js';

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

  it('accepts legacy cached payload with content field', () => {
    const cached = JSON.stringify({ content: 'Hi', truncated: true });
    const parsed = parseCachedMarkdownResult(cached);

    assert.ok(parsed);
    assert.equal(parsed.content, 'Hi');
    assert.equal(parsed.markdown, 'Hi');
    assert.equal(parsed.title, undefined);
    assert.equal(parsed.truncated, true);
  });

  it('rejects invalid JSON', () => {
    const parsed = parseCachedMarkdownResult('{');
    assert.equal(parsed, undefined);
  });

  it('rejects payloads without string markdown/content', () => {
    const parsed = parseCachedMarkdownResult(JSON.stringify({ markdown: 123 }));
    assert.equal(parsed, undefined);
  });
});
