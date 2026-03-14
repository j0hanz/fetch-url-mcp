import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../src/lib/content.js';

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
});
