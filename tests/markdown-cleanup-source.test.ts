import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../src/transform/markdown-cleanup.js';

describe('markdown cleanup source regression', () => {
  it('removes punctuation-only list artifacts from extracted markdown', () => {
    const input = [
      '# Title',
      '',
      '+ \\- ',
      '',
      '## How it works',
      '',
      'Real content stays.',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('+ \\-'), false);
    assert.match(cleaned, /## How it works/);
    assert.match(cleaned, /Real content stays\./);
  });

  it('preserves ordinary list items with text', () => {
    const input = ['- First item', '- Second item'].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.match(cleaned, /- First item/);
    assert.match(cleaned, /- Second item/);
  });

  it('escapes angle brackets in markdown link text', () => {
    const input = '- [<Button />](https://mui.com/api/button/)';
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(
      cleaned.includes('[\\<Button /\\>](https://mui.com/api/button/)'),
      `expected escaped angle brackets, got: ${cleaned}`
    );
  });

  it('removes trailing heading permalinks while preserving inline-code headings', () => {
    const input = ['##### Hello `code`[#](#hello-code)', '', 'some text'].join(
      '\n'
    );

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.match(cleaned, /^##### Hello `code`$/m);
    assert.match(cleaned, /some text/);
    assert.equal(cleaned.includes('[#](#hello-code)'), false);
  });

  it('repairs qualified identifier spacing and drops empty adjacent headings', () => {
    const input = [
      '#### `alpha(options)`[#](#alpha-options)',
      '',
      '#### `beta(source, options)`[#](#beta-options)',
      '',
      'Use [stream.finished()](#finished)[stream.Readable.from()](#from) and `stream.Writable`.',
      '',
      '[Stability: 2](#stability) \\- Stable',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('alpha(options)'), false);
    assert.match(cleaned, /#### `beta\(source, options\)`/);
    assert.match(
      cleaned,
      /\[stream\.finished\(\)\]\(#finished\) \[stream\.Readable\.from\(\)\]\(#from\)/
    );
    assert.match(cleaned, /`stream\.Writable`/);
    assert.match(cleaned, /\[Stability: 2]\(#stability\) - Stable/);
  });

  it('does not promote orphan prose immediately before an existing heading', () => {
    const input = [
      '## Article Header',
      '',
      'By Test Author',
      '',
      '## Section 1',
      '',
      'Content for section one.',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.match(cleaned, /## Article Header/);
    assert.match(cleaned, /\nBy Test Author\n/);
    assert.equal(cleaned.includes('## By Test Author'), false);
  });

  it('collapses inline-code padding and escapes placeholder brackets in table rows', () => {
    const input = [
      '| Class | Styles |',
      '| ----- | ------ |',
      '| h-<number> | height: calc(<number> * 100%); |',
      '',
      'Use `h-<number>` utilities like  `h-24` and  `h-64`.',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.match(
      cleaned,
      /\| h-\\<number\\> \| height: calc\(\\<number\\> \* 100%\); \|/
    );
    assert.match(
      cleaned,
      /Use `h-<number>` utilities like `h-24` and `h-64`\./
    );
  });
});
