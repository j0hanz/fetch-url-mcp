import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removeNoiseFromHtml } from '../dist/lib/dom-noise-removal.js';

describe('Dialog preservation', () => {
  it('preserves dialogs with >500 chars text content', () => {
    const longText = 'A'.repeat(550);
    const html = `
      <html>
        <body>
          <div role="dialog">
            <p>${longText}</p>
          </div>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Dialog should be preserved
    assert.ok(result.includes('role="dialog"'), 'Dialog should be preserved');
    assert.ok(result.includes(longText), 'Dialog content should be preserved');
  });

  it('removes dialogs with <500 chars text content (cookie banners)', () => {
    const shortText = 'This site uses cookies.';
    const html = `
      <html>
        <body>
          <div role="dialog">
            <p>${shortText}</p>
            <button>Accept</button>
          </div>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Dialog should be removed
    assert.ok(
      !result.includes('role="dialog"'),
      'Small dialog should be removed'
    );
    assert.ok(!result.includes(shortText), 'Dialog content should be removed');
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves short dialogs inside main content', () => {
    const shortText = 'Short dialog inside main.';
    const html = `
      <html>
        <body>
          <main>
            <div role="dialog">
              <p>${shortText}</p>
            </div>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('role="dialog"'),
      'Dialog inside main should be preserved'
    );
    assert.ok(
      result.includes(shortText),
      'Dialog content inside main should be preserved'
    );
  });

  it('preserves dialogs containing headings (structured content)', () => {
    const html = `
      <html>
        <body>
          <div role="dialog">
            <h2>Important Information</h2>
            <p>Short but structural content.</p>
          </div>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Dialog with heading should be preserved even if text is short
    assert.ok(
      result.includes('role="dialog"'),
      'Dialog with heading should be preserved'
    );
    assert.ok(
      result.includes('Important Information'),
      'Dialog heading should be preserved'
    );
  });

  it('preserves alertdialog role with substantial content', () => {
    const longText = 'B'.repeat(550);
    const html = `
      <html>
        <body>
          <div role="alertdialog">
            <p>${longText}</p>
          </div>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Alertdialog should also be preserved with same rules
    assert.ok(
      result.includes('role="alertdialog"'),
      'Alertdialog should be preserved'
    );
    assert.ok(
      result.includes(longText),
      'Alertdialog content should be preserved'
    );
  });
});

describe('Nav and footer preservation', () => {
  it('preserves nav containing semantic content elements', () => {
    const html = `
      <html>
        <body>
          <nav>
            <article>
              <h1>Article in nav</h1>
              <p>This is semantic content inside nav.</p>
            </article>
          </nav>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Nav containing article should be preserved
    assert.ok(result.includes('<nav>'), 'Nav with article should be preserved');
    assert.ok(
      result.includes('Article in nav'),
      'Nav article content should be preserved'
    );
  });

  it('removes nav without semantic content (typical navigation)', () => {
    const html = `
      <html>
        <body>
          <nav>
            <ul>
              <li><a href="/">Home</a></li>
              <li><a href="/about">About</a></li>
            </ul>
          </nav>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Navigation nav should be removed
    assert.ok(!result.includes('<nav>'), 'Navigation menu should be removed');
    assert.ok(!result.includes('Home'), 'Nav links should be removed');
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves footer containing main element', () => {
    const html = `
      <html>
        <body>
          <footer>
            <main>
              <h2>Footer Article</h2>
              <p>Important content in footer.</p>
            </main>
          </footer>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Footer with main should be preserved
    assert.ok(
      result.includes('<footer>'),
      'Footer with main should be preserved'
    );
    assert.ok(
      result.includes('Footer Article'),
      'Footer content should be preserved'
    );
  });

  it('removes footer without semantic content (typical site footer)', () => {
    const html = `
      <html>
        <body>
          <main>
            <p>Main content</p>
          </main>
          <footer>
            <p>© 2026 Example Site</p>
            <a href="/privacy">Privacy</a>
          </footer>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Site footer should be removed
    assert.ok(!result.includes('<footer>'), 'Site footer should be removed');
    assert.ok(!result.includes('© 2026'), 'Copyright should be removed');
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves nav containing section element', () => {
    const html = `
      <html>
        <body>
          <nav>
            <section>
              <h3>Featured Content</h3>
              <p>Important navigation with content.</p>
            </section>
          </nav>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Nav with section should be preserved
    assert.ok(result.includes('<nav>'), 'Nav with section should be preserved');
    assert.ok(
      result.includes('Featured Content'),
      'Nav section content should be preserved'
    );
  });

  it('preserves nav containing role=main content', () => {
    const html = `
      <html>
        <body>
          <nav>
            <div role="main">
              <p>Primary nav content</p>
            </div>
          </nav>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('<nav>'),
      'Nav with role=main should be preserved'
    );
    assert.ok(
      result.includes('Primary nav content'),
      'Role=main content should be preserved'
    );
  });
});

describe('Noise scan limits', () => {
  it('detects noise markers near the end of large HTML', () => {
    const filler = 'A'.repeat(60000);
    const html = `
      <html>
        <body>
          <div>${filler}</div>
          <nav><p>LATE_NAV</p></nav>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('LATE_NAV'),
      'Late nav content should be removed'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });
});
