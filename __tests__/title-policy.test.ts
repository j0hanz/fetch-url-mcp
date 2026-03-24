import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isGithubRepositoryRootUrl,
  maybePrependSyntheticTitle,
  maybeStripGithubPrimaryHeading,
  shouldPreferPrimaryHeadingTitle,
} from '../dist/transform/title-policy.js';

// ── shouldPreferPrimaryHeadingTitle ─────────────────────────────────

describe('shouldPreferPrimaryHeadingTitle', () => {
  it('returns false when primary heading is undefined', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle(undefined, 'Page Title'),
      false
    );
  });

  it('returns false when primary heading is empty', () => {
    assert.equal(shouldPreferPrimaryHeadingTitle('', 'Page Title'), false);
  });

  it('returns true when title is undefined', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle('My Heading', undefined),
      true
    );
  });

  it('returns true when title exactly matches heading', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle('Getting Started', 'Getting Started'),
      true
    );
  });

  it('returns true for case-insensitive match', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle('Getting Started', 'getting started'),
      true
    );
  });

  it('returns true when heading matches a part of a compound title', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle(
        'Introduction',
        'Introduction - My Docs Site'
      ),
      true
    );
  });

  it('returns true when heading matches title part after pipe separator', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle('Guide', 'Guide | Documentation'),
      true
    );
  });

  it('returns false when heading does not match any title part', () => {
    assert.equal(
      shouldPreferPrimaryHeadingTitle('Unrelated Content', 'My Docs Site'),
      false
    );
  });
});

// ── isGithubRepositoryRootUrl ──────────────────────────────────────

describe('isGithubRepositoryRootUrl', () => {
  it('returns true for github.com/owner/repo', () => {
    assert.equal(
      isGithubRepositoryRootUrl('https://github.com/owner/repo'),
      true
    );
  });

  it('returns true for www.github.com', () => {
    assert.equal(
      isGithubRepositoryRootUrl('https://www.github.com/owner/repo'),
      true
    );
  });

  it('returns false for deep paths', () => {
    assert.equal(
      isGithubRepositoryRootUrl('https://github.com/owner/repo/tree/main/src'),
      false
    );
  });

  it('returns false for non-github URLs', () => {
    assert.equal(
      isGithubRepositoryRootUrl('https://gitlab.com/owner/repo'),
      false
    );
  });

  it('returns false for invalid URLs', () => {
    assert.equal(isGithubRepositoryRootUrl('not a url'), false);
  });

  it('returns false for github.com root (no owner/repo)', () => {
    assert.equal(isGithubRepositoryRootUrl('https://github.com'), false);
  });

  it('returns false for single segment path', () => {
    assert.equal(isGithubRepositoryRootUrl('https://github.com/owner'), false);
  });
});

// ── maybeStripGithubPrimaryHeading ─────────────────────────────────

describe('maybeStripGithubPrimaryHeading', () => {
  it('strips leading heading for GitHub repo root URL', () => {
    const markdown = '# My Project\n\nSome description.';
    const result = maybeStripGithubPrimaryHeading(
      markdown,
      'My Project',
      'https://github.com/owner/repo'
    );
    assert.ok(!result.includes('# My Project'));
    assert.ok(result.includes('Some description'));
  });

  it('does not strip for non-GitHub URLs', () => {
    const markdown = '# My Project\n\nSome description.';
    const result = maybeStripGithubPrimaryHeading(
      markdown,
      'My Project',
      'https://example.com/page'
    );
    assert.ok(result.includes('# My Project'));
  });

  it('does not strip when heading is undefined', () => {
    const markdown = '# My Project\n\nText.';
    const result = maybeStripGithubPrimaryHeading(
      markdown,
      undefined,
      'https://github.com/owner/repo'
    );
    assert.ok(result.includes('# My Project'));
  });

  it('does not strip when heading does not match', () => {
    const markdown = '# Different Title\n\nText.';
    const result = maybeStripGithubPrimaryHeading(
      markdown,
      'My Project',
      'https://github.com/owner/repo'
    );
    assert.ok(result.includes('# Different Title'));
  });
});

// ── maybePrependSyntheticTitle ─────────────────────────────────────

describe('maybePrependSyntheticTitle', () => {
  it('prepends title when markdown has no heading', () => {
    const result = maybePrependSyntheticTitle('Some content.', {
      title: 'Page Title',
    });
    assert.ok(result.startsWith('# Page Title'));
    assert.ok(result.includes('Some content'));
  });

  it('does not prepend when markdown already starts with heading', () => {
    const markdown = '# Existing Heading\n\nContent.';
    const result = maybePrependSyntheticTitle(markdown, {
      title: 'Page Title',
    });
    assert.ok(result.startsWith('# Existing'));
    assert.ok(!result.includes('Page Title'));
  });

  it('does not prepend when title is undefined', () => {
    const markdown = 'Content without heading.';
    const result = maybePrependSyntheticTitle(markdown, { title: undefined });
    assert.equal(result, markdown);
  });

  it('does not prepend when title is empty', () => {
    const markdown = 'Content.';
    const result = maybePrependSyntheticTitle(markdown, { title: '' });
    assert.equal(result, markdown);
  });

  it('handles leading whitespace before heading', () => {
    const markdown = '  # Heading\n\nContent.';
    const result = maybePrependSyntheticTitle(markdown, {
      title: 'Page Title',
    });
    // Leading whitespace before # should still be recognized as a heading
    assert.ok(!result.includes('Page Title'));
  });
});
