import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import {
  addSourceToMarkdown,
  buildMetadataFooter,
  extractMetadata,
  extractMetadataFromHead,
  extractTitleFromRawMarkdown,
  isRawTextContent,
  mergeMetadata,
  normalizeDocumentTitle,
} from '../dist/transform/metadata.js';

// ── normalizeDocumentTitle ──────────────────────────────────────────

describe('normalizeDocumentTitle', () => {
  it('returns title unchanged when no baseUrl', () => {
    assert.equal(normalizeDocumentTitle('My Title'), 'My Title');
  });

  it('returns title unchanged for non-GitHub URLs', () => {
    assert.equal(
      normalizeDocumentTitle('My Title', 'https://example.com/owner/repo'),
      'My Title'
    );
  });

  it('normalizes GitHub repo title to owner/repo', () => {
    assert.equal(
      normalizeDocumentTitle(
        'GitHub - owner/repo: A description',
        'https://github.com/owner/repo'
      ),
      'owner/repo'
    );
  });

  it('does not normalize for deep GitHub paths', () => {
    const title = 'GitHub - owner/repo: desc';
    assert.equal(
      normalizeDocumentTitle(title, 'https://github.com/owner/repo/tree/main'),
      title
    );
  });

  it('returns title when it does not start with "GitHub - "', () => {
    assert.equal(
      normalizeDocumentTitle('Some Title', 'https://github.com/owner/repo'),
      'Some Title'
    );
  });

  it('handles www.github.com', () => {
    assert.equal(
      normalizeDocumentTitle(
        'GitHub - owner/repo: desc',
        'https://www.github.com/owner/repo'
      ),
      'owner/repo'
    );
  });
});

// ── extractMetadata ─────────────────────────────────────────────────

describe('extractMetadata', () => {
  function parseDoc(html: string): Document {
    return parseHTML(html).document;
  }

  it('extracts og:title from meta tags', () => {
    const doc = parseDoc(`
      <html><head>
        <meta property="og:title" content="OG Title" />
        <title>Standard Title</title>
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.title, 'OG Title');
  });

  it('falls back to twitter:title', () => {
    const doc = parseDoc(`
      <html><head>
        <meta name="twitter:title" content="Twitter Title" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.title, 'Twitter Title');
  });

  it('falls back to standard title tag', () => {
    const doc = parseDoc(`
      <html><head>
        <title>Fallback Title</title>
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.title, 'Fallback Title');
  });

  it('extracts description with og priority', () => {
    const doc = parseDoc(`
      <html><head>
        <meta property="og:description" content="OG Desc" />
        <meta name="description" content="Standard Desc" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.description, 'OG Desc');
  });

  it('extracts author', () => {
    const doc = parseDoc(`
      <html><head>
        <meta name="author" content="John Doe" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.author, 'John Doe');
  });

  it('extracts og:image', () => {
    const doc = parseDoc(`
      <html><head>
        <meta property="og:image" content="https://example.com/img.png" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.image, 'https://example.com/img.png');
  });

  it('extracts favicon link', () => {
    const doc = parseDoc(`
      <html><head>
        <link rel="icon" sizes="32x32" href="/favicon-32x32.png" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc, 'https://example.com');
    assert.equal(meta.favicon, 'https://example.com/favicon-32x32.png');
  });

  it('ignores data: URI favicons', () => {
    const doc = parseDoc(`
      <html><head>
        <link rel="icon" href="data:image/png;base64,abc" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc, 'https://example.com');
    assert.equal(meta.favicon, undefined);
  });

  it('returns empty object when no metadata present', () => {
    const doc = parseDoc('<html><head></head><body></body></html>');
    const meta = extractMetadata(doc);
    assert.deepEqual(meta, {});
  });

  it('extracts article timestamps', () => {
    const doc = parseDoc(`
      <html><head>
        <meta property="article:published_time" content="2024-01-01T00:00:00Z" />
        <meta property="article:modified_time" content="2024-06-15T12:00:00Z" />
      </head><body></body></html>
    `);
    const meta = extractMetadata(doc);
    assert.equal(meta.publishedAt, '2024-01-01T00:00:00Z');
    assert.equal(meta.modifiedAt, '2024-06-15T12:00:00Z');
  });
});

// ── extractMetadataFromHead ─────────────────────────────────────────

describe('extractMetadataFromHead', () => {
  it('extracts metadata from raw HTML head section', () => {
    const html =
      '<html><head><title>Test</title><meta property="og:title" content="OG Test" /></head><body>Content</body></html>';
    const meta = extractMetadataFromHead(html);
    assert.ok(meta);
    assert.equal(meta.title, 'OG Test');
  });

  it('returns null when no head section found', () => {
    assert.equal(extractMetadataFromHead('just plain text'), null);
  });

  it('handles HTML without closing head tag within scan limit', () => {
    const longBody = 'x'.repeat(60_000);
    const html = `<html><head><title>Test</title>${longBody}`;
    // No </head> or <body> within first 50K chars
    const meta = extractMetadataFromHead(html);
    assert.equal(meta, null);
  });
});

// ── mergeMetadata ───────────────────────────────────────────────────

describe('mergeMetadata', () => {
  it('returns late metadata when early is null', () => {
    const late = { title: 'Late', description: 'Desc' };
    assert.deepEqual(mergeMetadata(null, late), late);
  });

  it('prefers late values over early', () => {
    const early = { title: 'Early', description: 'Early Desc' };
    const late = { title: 'Late' };
    const merged = mergeMetadata(early, late);
    assert.equal(merged.title, 'Late');
    assert.equal(merged.description, 'Early Desc');
  });

  it('fills gaps from early metadata', () => {
    const early = { author: 'Author', image: 'img.png' };
    const late = { title: 'Title' };
    const merged = mergeMetadata(early, late);
    assert.equal(merged.title, 'Title');
    assert.equal(merged.author, 'Author');
    assert.equal(merged.image, 'img.png');
  });
});

// ── extractTitleFromRawMarkdown ─────────────────────────────────────

describe('extractTitleFromRawMarkdown', () => {
  it('extracts title from frontmatter', () => {
    const md = '---\ntitle: My Title\n---\n\n# Heading\n\nContent';
    assert.equal(extractTitleFromRawMarkdown(md), 'My Title');
  });

  it('extracts name from frontmatter when no title', () => {
    const md = '---\nname: Widget\n---\n\nContent';
    assert.equal(extractTitleFromRawMarkdown(md), 'Widget');
  });

  it('extracts title from first heading when no frontmatter', () => {
    const md = '# My Heading\n\nSome content.';
    assert.equal(extractTitleFromRawMarkdown(md), 'My Heading');
  });

  it('returns undefined when no title found', () => {
    assert.equal(
      extractTitleFromRawMarkdown('Just text, no heading.'),
      undefined
    );
  });

  it('strips surrounding quotes from frontmatter title', () => {
    const md = '---\ntitle: "Quoted Title"\n---\n\nContent';
    assert.equal(extractTitleFromRawMarkdown(md), 'Quoted Title');
  });

  it('extracts heading from body after frontmatter', () => {
    const md = '---\nauthor: Someone\n---\n\n# Body Heading\n\nContent';
    assert.equal(extractTitleFromRawMarkdown(md), 'Body Heading');
  });
});

// ── addSourceToMarkdown ─────────────────────────────────────────────

describe('addSourceToMarkdown', () => {
  it('injects source in markdown format when no frontmatter exists', () => {
    const result = addSourceToMarkdown(
      '# Hello\n\nContent',
      'https://example.com'
    );
    assert.ok(result.includes('Source: https://example.com'));
  });

  it('injects source into existing frontmatter', () => {
    const md = '---\ntitle: Test\n---\n\n# Hello';
    const result = addSourceToMarkdown(md, 'https://example.com/page');
    assert.ok(result.includes('source:'));
    assert.ok(result.includes('https://example.com/page'));
    assert.ok(result.includes('title: Test'));
  });

  it('does not duplicate source if already present in frontmatter', () => {
    const md = '---\nsource: "https://old.com"\n---\n\nContent';
    const result = addSourceToMarkdown(md, 'https://new.com');
    assert.equal(result, md);
  });

  it('does not duplicate source when Source: already exists in markdown format', () => {
    const md = '# Hello\n\nSource: https://old.com\n\nContent';
    const result = addSourceToMarkdown(md, 'https://new.com');
    assert.equal(result, md);
  });
});

// ── isRawTextContent ────────────────────────────────────────────────

describe('isRawTextContent', () => {
  it('returns false for HTML documents', () => {
    assert.equal(isRawTextContent('<!DOCTYPE html><html>...'), false);
  });

  it('returns true for content with markdown headings', () => {
    assert.equal(isRawTextContent('# Hello\n\nContent'), true);
  });

  it('returns true for content with list markers', () => {
    assert.equal(isRawTextContent('- item 1\n- item 2'), true);
  });

  it('returns true for content with code fences', () => {
    assert.equal(isRawTextContent('```js\ncode\n```'), true);
  });

  it('returns true for content with frontmatter', () => {
    assert.equal(isRawTextContent('---\ntitle: Test\n---\n\nContent'), true);
  });

  it('returns false for content with many HTML tags', () => {
    const tags = '<div>a</div>'.repeat(10);
    assert.equal(isRawTextContent(tags), false);
  });
});

// ── buildMetadataFooter ─────────────────────────────────────────────

describe('buildMetadataFooter', () => {
  const base = {
    type: 'metadata' as const,
    url: 'https://example.com',
    fetchedAt: '2024-01-01T00:00:00Z',
  };

  it('returns empty string for undefined metadata', () => {
    assert.equal(buildMetadataFooter(undefined), '');
  });

  it('includes title in footer', () => {
    const result = buildMetadataFooter({ ...base, title: 'Page' });
    assert.ok(result.includes('_Page_'));
  });

  it('includes source link from metadata url', () => {
    const result = buildMetadataFooter(base);
    assert.ok(result.includes('[_Original Source_](https://example.com)'));
  });

  it('includes source link with fallback URL when metadata url missing', () => {
    const result = buildMetadataFooter(
      { ...base, url: '' },
      'https://fallback.com'
    );
    assert.ok(result.includes('https://fallback.com'));
  });

  it('includes author', () => {
    const result = buildMetadataFooter({ ...base, author: 'Jane' });
    assert.ok(result.includes('_Jane_'));
  });

  it('includes description as sub', () => {
    const result = buildMetadataFooter({
      ...base,
      description: 'A description',
    });
    assert.ok(result.includes('<sub>A description</sub>'));
  });
});
