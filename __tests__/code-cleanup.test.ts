import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import {
  removeNoiseFromHtml,
  surfaceCodeEditorContent,
} from '../src/transform/index.js';

// Padding ensures body innerHTML > 100 chars after cleanup (MIN_BODY_CONTENT_LENGTH).
const PAD =
  '<p>This paragraph provides enough body text content for the serialization threshold during testing.</p>';

function clean(bodyHtml: string): string {
  const html = `<html><body><main>${bodyHtml}${PAD}</main></body></html>`;
  return removeNoiseFromHtml(html, undefined, 'https://example.com');
}

describe('Copy button stripping in code blocks', () => {
  it('removes <button> elements inside <pre>', () => {
    const result = clean(
      '<pre><code>const x = 1;</code><button>Copy</button></pre>'
    );
    assert.ok(!result.includes('Copy'), 'Copy button text must be removed');
    assert.ok(result.includes('const x = 1'), 'Code content preserved');
  });

  it('removes "Copy code" button text', () => {
    const result = clean(
      '<pre><code>console.log("hi")</code><button>Copy code</button></pre>'
    );
    assert.ok(
      !result.includes('Copy code'),
      '"Copy code" button must be removed'
    );
    assert.ok(result.includes('console.log'), 'Code content preserved');
  });

  it('removes href="#copy" anchors inside <pre>', () => {
    const result = clean(
      '<pre><code>fn main() {}</code><a href="#copy">Copy</a></pre>'
    );
    assert.ok(!result.includes('#copy'), 'href="#copy" anchor must be removed');
    assert.ok(result.includes('fn main'), 'Code content preserved');
  });

  it('removes span[class*="copy"] with copy text inside <pre>', () => {
    const result = clean(
      '<pre><code>import os</code><span class="copy-button">Copy</span></pre>'
    );
    assert.ok(!result.includes('>Copy<'), 'Copy span must be removed');
    assert.ok(result.includes('import os'), 'Code content preserved');
  });
});

describe('surfaceCodeEditorContent', () => {
  it('surfaces textarea content from aria-hidden pre blocks', () => {
    const html = `<html><body><div>
      <pre aria-hidden="true"><code class="language-javascript">highlighted</code></pre>
      <textarea>const raw = true;</textarea>
    </div></body></html>`;
    const { document } = parseHTML(html);
    surfaceCodeEditorContent(document);
    const body = document.body.innerHTML;
    assert.ok(
      body.includes('const raw = true'),
      'Textarea content must be surfaced'
    );
    assert.ok(
      body.includes('language-javascript'),
      'Language class must be preserved'
    );
  });

  it('does nothing when no textarea sibling exists', () => {
    const html = `<html><body><div>
      <pre aria-hidden="true"><code>some code</code></pre>
    </div></body></html>`;
    const { document } = parseHTML(html);
    surfaceCodeEditorContent(document);
    const body = document.body.innerHTML;
    assert.ok(
      body.includes('aria-hidden'),
      'Pre must remain when no textarea found'
    );
  });
});
