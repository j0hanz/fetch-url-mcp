import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../dist/lib/markdown-cleanup.js';

describe('Header Promotion', () => {
  it('promotes orphan short lines to headings', () => {
    const markdown = `
Previous text.

Overview

Next text.
    `.trim();

    const cleaned = cleanupMarkdownArtifacts(markdown);
    assert.ok(cleaned.includes('## Overview'));
  });

  it('promotes special prefixes', () => {
    const markdown = `
Note: This is important.
    `.trim();

    // According to promoteOrphanHeadings: "Note: " -> "## Note: "
    const cleaned = cleanupMarkdownArtifacts(markdown);
    assert.ok(cleaned.includes('## Note: This is important.'));
  });

  it('does not promote long lines', () => {
    const markdown = `
This is a very long line that should definitely not be promoted to a heading because it exceeds the maximum length threshold defined in the heuristics.
    `.trim();

    const cleaned = cleanupMarkdownArtifacts(markdown);
    assert.ok(!cleaned.includes('## This is a very long line'));
  });

  it('does not promote lines with existing markup', () => {
    const markdown = `
- List item
    `.trim();
    const cleaned = cleanupMarkdownArtifacts(markdown);
    assert.equal(cleaned, '- List item');
  });
});
