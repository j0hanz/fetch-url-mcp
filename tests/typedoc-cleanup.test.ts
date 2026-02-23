import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToMarkdown } from '../dist/transform/transform.js';

describe('TypeDoc cleanup', () => {
  it('removes TypeDoc style comments from text', () => {
    const html = `
      <p>Here is some /* internal implementation details */ text.</p>
    `;
    const markdown = htmlToMarkdown(html);
    // Note: htmlToMarkdown adds a metadata footer, so we check inclusion or start
    // assert.ok(markdown.startsWith('Here is some text.'));
    const firstLine = markdown.split('\n')[0];
    assert.equal(firstLine, 'Here is some text.');
    assert.ok(!markdown.includes('internal implementation details'));
  });

  it('preserves inline code containing comment-like syntax', () => {
    const html = `
      <p>Use the <code>/* wildcard */</code> syntax.</p>
    `;
    const markdown = htmlToMarkdown(html);
    assert.ok(markdown.includes('`/* wildcard */`'));
  });

  it('preserves code blocks containing comments', () => {
    const html = `
      <pre><code>
/* comment */
const x = 1;
      </code></pre>
    `;
    const markdown = htmlToMarkdown(html);
    // Block code is preserved by splitByFences mechanism
    assert.ok(markdown.includes('/* comment */'));
    assert.ok(markdown.includes('const x = 1;'));
  });
});
