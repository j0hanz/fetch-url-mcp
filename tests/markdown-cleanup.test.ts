import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../dist/lib/md-cleanup.js';

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

  it('removes "On this page" TOC with pure anchor links', () => {
    const input = [
      '## On this page',
      '- [Card](#card)',
      '- [Import](#import)',
      '- [Usage](#usage)',
      '',
      '## Card',
      'A card component.',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('On this page'), false);
    assert.equal(cleaned.includes('[Card](#card)'), false);
    assert.ok(cleaned.includes('## Card'));
    assert.ok(cleaned.includes('A card component.'));
  });

  it('removes anchor-only heading with no following content', () => {
    const input = [
      '## Real',
      'Some body text.',
      '',
      '### [With Image](#with-image)',
      '',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.equal(cleaned.includes('With Image'), false);
    assert.ok(cleaned.includes('## Real'));
    assert.ok(cleaned.includes('Some body text.'));
  });

  it('normalizes anchor-only heading when followed by content', () => {
    const input = ['### [Usage](#usage)', 'Use the component like this.'].join(
      '\n'
    );

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.includes('### Usage'));
    assert.ok(!cleaned.includes('### [Usage](#usage)'));
    assert.ok(cleaned.includes('Use the component like this.'));
  });

  it('escapes angle brackets in markdown link text', () => {
    const input = '- [<Button />](https://mui.com/api/button/)';
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(
      cleaned.includes('[\\<Button /\\>](https://mui.com/api/button/)'),
      `expected escaped angle brackets, got: ${cleaned}`
    );
    assert.equal(cleaned.includes('[<Button'), false);
  });

  it('escapes angle brackets in multiple API links', () => {
    const input = [
      '- [<FormControl />](https://mui.com/api/form-control/)',
      '- [<InputLabel />](https://mui.com/api/input-label/)',
    ].join('\n');
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.includes('\\<FormControl /\\>'));
    assert.ok(cleaned.includes('\\<InputLabel /\\>'));
  });

  it('trims padding around token-like inline code spans', () => {
    const input = [
      'Use ` tools/call` and ` name` to invoke `two words` safely.',
      'Keep `already-clean` unchanged.',
    ].join('\n');
    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.includes('`tools/call`'));
    assert.ok(cleaned.includes('`name`'));
    assert.ok(cleaned.includes('`already-clean`'));
  });

  it('removes leading docs chrome controls near the top of the document', () => {
    const input = [
      '# Introduction',
      '',
      'Edit this page',
      '',
      'Toggle table of contents sidebar',
      '',
      '## Features',
      '',
      'Feature details.',
    ].join('\n');

    const cleaned = cleanupMarkdownArtifacts(input);

    assert.ok(cleaned.startsWith('# Introduction'));
    assert.equal(cleaned.includes('Edit this page'), false);
    assert.equal(cleaned.includes('Toggle table of contents sidebar'), false);
    assert.ok(cleaned.includes('## Features'));
    assert.ok(cleaned.includes('Feature details.'));
  });
});
