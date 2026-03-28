import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import {
  evaluateArticleContent,
  getVisibleTextLength,
} from '../src/transform/index.js';
import type { ExtractedArticle } from '../src/transform/index.js';

function makeArticle(content: string, textContent?: string): ExtractedArticle {
  return {
    content,
    textContent:
      textContent ??
      content
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
  };
}

function makeDocument(html: string): Document {
  return parseHTML(
    html.includes('<html')
      ? html
      : `<!DOCTYPE html><html><body>${html}</body></html>`
  ).document;
}

// ── evaluateArticleContent ──────────────────────────────────────────

describe('evaluateArticleContent — content ratio gate', () => {
  it('passes when article has sufficient content ratio', () => {
    const bodyText = 'Real article content. '.repeat(20);
    const originalHtml = `<p>${bodyText}</p>`;
    const doc = makeDocument(originalHtml);
    const article = makeArticle(`<p>${bodyText}</p>`);
    const result = evaluateArticleContent(article, doc);
    assert.ok(result !== null, 'Should pass with good content ratio');
  });

  it('fails when article text is too short relative to original', () => {
    const longOriginal = 'Long original text content. '.repeat(50);
    const shortArticle = 'Short.';
    const doc = makeDocument(`<p>${longOriginal}</p>`);
    const article = makeArticle(`<p>${shortArticle}</p>`, shortArticle);
    const result = evaluateArticleContent(article, doc);
    assert.equal(result, null, 'Should fail with low content ratio');
  });
});

describe('evaluateArticleContent — retention rules', () => {
  it('fails when headings are lost from article', () => {
    // Original has many headings, article retains none
    const originalHtml = `
      <h1>Title</h1><p>Intro</p>
      <h2>Section 1</h2><p>Content 1</p>
      <h2>Section 2</h2><p>Content 2</p>
      <h2>Section 3</h2><p>Content 3</p>
    `;
    const doc = makeDocument(originalHtml);
    // Article has same text but no headings
    const articleText = 'Title Intro Content 1 Content 2 Content 3';
    const article = makeArticle(`<p>${articleText}</p>`, articleText);
    const result = evaluateArticleContent(article, doc);
    assert.equal(result, null, 'Should fail when headings are not retained');
  });
});

describe('evaluateArticleContent — truncated sentences', () => {
  it('fails when most lines lack sentence endings', () => {
    // Build content where every line is truncated (no period/question/etc.)
    const truncatedLines = Array.from(
      { length: 10 },
      (_, i) =>
        `This is a truncated line number ${i} that does not end properly`
    );
    const textContent = truncatedLines.join('\n');
    const htmlContent = truncatedLines.map((line) => `<p>${line}</p>`).join('');
    const doc = makeDocument(htmlContent);
    const article = makeArticle(htmlContent, textContent);
    const result = evaluateArticleContent(article, doc);
    assert.equal(result, null, 'Should fail with truncated sentences');
  });
});

describe('evaluateArticleContent — empty section ratio', () => {
  it('fails when too many headings have no section content', () => {
    // 6 headings, all empty (no content after any of them)
    const headings = Array.from(
      { length: 6 },
      (_, i) => `<h2>Empty Section ${i}</h2>`
    ).join('');
    const articleHtml = headings;
    const articleText = Array.from(
      { length: 6 },
      (_, i) => `Empty Section ${i}`
    ).join(' ');
    const doc = makeDocument(`<p>${articleText}</p>`);
    const article = makeArticle(articleHtml, articleText);
    const result = evaluateArticleContent(article, doc);
    assert.equal(
      result,
      null,
      'Should fail when all headings have empty sections'
    );
  });

  it('passes when screen-reader headings are excluded from ratio', () => {
    // 5 real headings with content + 1 screen-reader heading (empty)
    const realHeadings = Array.from(
      { length: 5 },
      (_, i) => `<h2>Section ${i}</h2><p>Content for section ${i}.</p>`
    ).join('');
    const srHeading = '<h2 class="screen-reader-text">Read more articles</h2>';
    const articleHtml = realHeadings + srHeading;
    const textParts = Array.from(
      { length: 5 },
      (_, i) => `Section ${i} Content for section ${i}.`
    );
    const articleText = textParts.join(' ') + ' Read more articles';
    const doc = makeDocument(`<p>${articleText}</p>`);
    const article = makeArticle(articleHtml, articleText);
    const result = evaluateArticleContent(article, doc);
    assert.ok(
      result !== null,
      'Should pass when screen-reader heading is excluded'
    );
  });
});

// ── getVisibleTextLength ────────────────────────────────────────────

describe('getVisibleTextLength', () => {
  it('counts visible text from HTML string', () => {
    const html =
      '<html><body><p>Hello World</p><script>var x=1;</script></body></html>';
    const len = getVisibleTextLength(html);
    assert.ok(len >= 11, 'Should count "Hello World" (11 chars)');
    assert.ok(len < 30, 'Should not include script content');
  });

  it('excludes style tag content', () => {
    const html =
      '<html><body><p>Text</p><style>body{color:red}</style></body></html>';
    const len = getVisibleTextLength(html);
    assert.ok(len >= 4, 'Should count "Text"');
    assert.ok(len < 20, 'Should not include style content');
  });

  it('handles Document input and excludes hidden elements', () => {
    const doc = makeDocument(
      '<p>Visible</p><div aria-hidden="true">Hidden</div><div hidden>Also hidden</div>'
    );
    const len = getVisibleTextLength(doc);
    assert.ok(len >= 7, 'Should count "Visible" (7 chars)');
    assert.ok(len < 25, 'Should not include hidden content');
  });

  it('returns 0 for empty document', () => {
    const len = getVisibleTextLength('<html><body></body></html>');
    assert.equal(len, 0, 'Empty document should return 0');
  });
});
