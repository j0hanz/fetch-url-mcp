import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../dist/lib/markdown-cleanup.js';

describe('markdown cleanup', () => {
  it('preserves bold code key-value pairs not TypeDoc artifacts', () => {
    const input = '**`baseUrl`**: Base URL for the API.';
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.includes('**`baseUrl`**: Base URL for the API.'));
  });

  it('removes actual TypeDoc artifacts', () => {
    const input = ['Defined in: **`src/index.ts`**', '', 'Extra content.'].join(
      '\n'
    );
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('Defined in:'), false);
    assert.match(cleaned, /Extra content/i);
  });

  it('preserves TOC with descriptive content', () => {
    const input = [
      '## Contents',
      'This guide explains the main sections.',
      '- [Intro](#intro)',
      '- [Usage](#usage)',
      '',
      '## Intro',
      'Hello',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.includes('## Contents'));
    assert.ok(cleaned.includes('This guide explains the main sections.'));
    assert.ok(cleaned.includes('[Intro](#intro)'));
  });

  it('removes auto-generated TOC with pure anchor links', () => {
    const input = [
      '## Contents',
      '- [Intro](#intro)',
      '- [Usage](#usage)',
      '',
      '## Intro',
      'Hello',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('## Contents'), false);
    assert.equal(cleaned.includes('[Intro](#intro)'), false);
  });
});
