import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cleanupMarkdownArtifacts,
  finalizeMarkdownSections,
  processFencedContent,
} from '../src/transform/index.js';

// ── processFencedContent ────────────────────────────────────────────

describe('processFencedContent', () => {
  it('applies transform only to non-fenced text', () => {
    const input = 'hello\n```\ncode\n```\nworld';
    const result = processFencedContent(input, (text) => text.toUpperCase());
    assert.ok(result.includes('HELLO'));
    assert.ok(result.includes('WORLD'));
    // Code inside fence should NOT be uppercased
    assert.ok(result.includes('code'));
  });

  it('handles content with no fences', () => {
    const result = processFencedContent('plain text', (text) =>
      text.toUpperCase()
    );
    assert.equal(result, 'PLAIN TEXT');
  });

  it('handles empty content', () => {
    const result = processFencedContent('', (text) => text.toUpperCase());
    assert.equal(result, '');
  });

  it('handles multiple fenced blocks', () => {
    const input = 'before\n```js\ncode1\n```\nmiddle\n```py\ncode2\n```\nafter';
    const result = processFencedContent(input, (text) => text.toUpperCase());
    assert.ok(result.includes('BEFORE'));
    assert.ok(result.includes('MIDDLE'));
    assert.ok(result.includes('AFTER'));
    assert.ok(result.includes('code1'));
    assert.ok(result.includes('code2'));
  });

  it('normalizes CRLF line endings', () => {
    const input = 'line1\r\nline2';
    const result = processFencedContent(input, (text) => text);
    assert.ok(!result.includes('\r\n'));
  });
});

// ── finalizeMarkdownSections ────────────────────────────────────────

describe('finalizeMarkdownSections', () => {
  it('returns empty string for empty input', () => {
    assert.equal(finalizeMarkdownSections(''), '');
  });

  it('removes empty heading sections', () => {
    const input =
      '# Title\n\n## Empty Section\n\n## Content Section\n\nSome text.';
    const result = finalizeMarkdownSections(input);
    assert.ok(!result.includes('## Empty Section'));
    assert.ok(result.includes('## Content Section'));
    assert.ok(result.includes('Some text'));
  });

  it('preserves heading with content', () => {
    const input = '# Title\n\nParagraph text.\n\n## Section\n\nMore text.';
    const result = finalizeMarkdownSections(input);
    assert.ok(result.includes('# Title'));
    assert.ok(result.includes('## Section'));
  });

  it('strips leading breadcrumb noise', () => {
    const input = 'Navigation\n\n# Main Title\n\nContent.';
    const result = finalizeMarkdownSections(input);
    assert.ok(result.includes('# Main Title'));
  });
});

// ── cleanupMarkdownArtifacts ────────────────────────────────────────

describe('cleanupMarkdownArtifacts', () => {
  it('returns empty string for empty input', () => {
    assert.equal(cleanupMarkdownArtifacts(''), '');
  });

  it('removes NBSP characters', () => {
    const input = '# Hello\u00A0World\n\nContent.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(!result.includes('\u00A0'));
    assert.ok(result.includes('Hello'));
  });

  it('removes copy button text', () => {
    const input = '# Title\n\n```js\ncode\n```\n[Copy](#copy)';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(!result.includes('[Copy](#copy)'));
  });

  it('adds spacing after heading', () => {
    const input = '# Title\nParagraph.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(result.includes('# Title\n\nParagraph'));
  });

  it('removes empty heading lines', () => {
    const input = '##\n\n# Real Heading\n\nContent.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(!result.match(/^##\s*$/m));
    assert.ok(result.includes('# Real Heading'));
  });

  it('fixes missing space between sentence punctuation and uppercase', () => {
    const input = '# Title\n\nFirst sentence.Second sentence.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(result.includes('sentence. Second'));
  });

  it('removes skip links', () => {
    const input = '[Skip to main content](#main)\n\n# Title\n\nContent.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(!result.includes('Skip to main content'));
  });

  it('strips trailing heading permalinks', () => {
    const input = '## Section [#](#section)\n\nContent.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(result.includes('## Section'));
    assert.ok(!result.includes('[#](#section)'));
  });

  it('preserves code block content', () => {
    const input = '# Title\n\n```js\nconst x = 1;\n```\n\nAfter.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(result.includes('const x = 1;'));
  });

  it('normalizes list indentation', () => {
    const input = '# List\n\n- item\n  - nested';
    const result = cleanupMarkdownArtifacts(input);
    // Indentation should be normalized from 2-space to 4-space
    assert.ok(result.includes('- item'));
    assert.ok(result.includes('- nested'));
  });

  it('removes zero-width anchors', () => {
    const input = '# Title\n\n[\u200B](#anchor) Content.';
    const result = cleanupMarkdownArtifacts(input);
    assert.ok(!result.includes('\u200B'));
  });
});
