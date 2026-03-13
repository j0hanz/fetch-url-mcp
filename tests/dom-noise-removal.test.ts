import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removeNoiseFromHtml } from '../dist/lib/content.js';

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

describe('Visibility hidden removal', () => {
  it('removes elements with inline visibility:hidden', () => {
    const html = `
      <html>
        <body>
          <div style="visibility: hidden">
            <p>Hidden content</p>
          </div>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Hidden content'),
      'visibility:hidden content should be removed'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('removes elements with visibility:hidden (no space)', () => {
    const html = `
      <html>
        <body>
          <div style="visibility:hidden">
            <p>Hidden no space</p>
          </div>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Hidden no space'),
      'visibility:hidden (no space) content should be removed'
    );
  });
});

describe('Template element removal', () => {
  it('removes template elements as structural noise', () => {
    const html = `
      <html>
        <body>
          <template id="my-template">
            <div>Template content</div>
          </template>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Template content'),
      'Template content should be removed'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });
});

describe('Header noise scoring', () => {
  it('preserves header without noise indicators', () => {
    const html = `
      <html>
        <body>
          <header class="article-header">
            <h1>Article Title</h1>
            <p>Published on 2026-01-01</p>
          </header>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('Article Title'),
      'Header without noise patterns should be preserved'
    );
  });

  it('removes boilerplate header with noise patterns', () => {
    const html = `
      <html>
        <body>
          <header class="site-header" role="navigation">
            <nav>
              <a href="/">Home</a>
              <a href="/about">About</a>
            </nav>
          </header>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('site-header'),
      'Boilerplate header should be removed'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });
});

describe('Social embed promo detection', () => {
  it('promo tokens alone do not exceed threshold', () => {
    const html = `
      <html>
        <body>
          <main>
            <p>Main content</p>
          </main>
          <div class="twitter-tweet">
            <p>Embedded tweet</p>
          </div>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    // Promo score (35) alone does not reach threshold (50)
    assert.ok(
      result.includes('Embedded tweet'),
      'Promo-only element should be preserved (below threshold)'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });
});

describe('Aside noise removal', () => {
  it('removes sidebar aside outside primary content', () => {
    const html = `
      <html>
        <body>
          <aside class="sidebar">
            <ul>
              <li><a href="/docs">Docs</a></li>
              <li><a href="/about">About</a></li>
            </ul>
          </aside>
          <main>
            <p>Main content</p>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(!result.includes('<aside'), 'Sidebar aside should be removed');
    assert.ok(!result.includes('Docs'), 'Sidebar links should be removed');
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves aside inside main content', () => {
    const html = `
      <html>
        <body>
          <main>
            <p>Main content</p>
            <aside class="note">
              <p>Important sidebar note relevant to the article.</p>
            </aside>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('Important sidebar note'),
      'Aside inside main should be preserved'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves aside inside article', () => {
    const html = `
      <html>
        <body>
          <article>
            <p>Article content</p>
            <aside>
              <p>Related info inside article.</p>
            </aside>
          </article>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('Related info inside article'),
      'Aside inside article should be preserved'
    );
  });

  it('removes aside with role=complementary outside primary content', () => {
    const html = `
      <html>
        <body>
          <aside role="complementary" class="sidebar-nav">
            <nav><a href="/">Home</a></nav>
          </aside>
          <main><p>Main content</p></main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('sidebar-nav'),
      'Complementary aside outside main should be removed'
    );
  });

  it('removes navigation-heavy aside inside main (SPA sidebar)', () => {
    const links = Array.from(
      { length: 20 },
      (_, i) => `<a href="/page-${i}">Page ${i}</a>`
    ).join('');
    const html = `
      <html>
        <body>
          <main>
            <aside class="sidebar">${links}</aside>
            <div><p>Main content</p></div>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Page 0'),
      'Navigation-heavy aside inside main should be removed'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('removes aside containing nav element inside main', () => {
    const html = `
      <html>
        <body>
          <main>
            <aside>
              <nav><a href="/">Home</a><a href="/about">About</a></nav>
            </aside>
            <div><p>Main content</p></div>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Home'),
      'Aside with nav inside main should be removed'
    );
  });
});

describe('Button data-state noise removal', () => {
  it('removes button with data-state="closed" as structural noise', () => {
    const html = `
      <html>
        <body>
          <main>
            <p>Main content</p>
          </main>
          <button data-state="closed">Scroll to top</button>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Scroll to top'),
      'Closed button should be removed as structural noise'
    );
    assert.ok(
      result.includes('Main content'),
      'Main content should be preserved'
    );
  });

  it('preserves div with data-state="closed" (non-structural)', () => {
    const html = `
      <html>
        <body>
          <main>
            <p>Main content</p>
            <div data-state="closed" data-accordion-item>
              <p>Accordion content</p>
            </div>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      result.includes('Accordion content'),
      'Non-structural data-state="closed" elements should be preserved'
    );
  });
});

describe('Tab trigger removal', () => {
  it('removes button[role="tab"] elements from output', () => {
    const html = `
      <html>
        <body>
          <main>
            <div role="tablist">
              <button role="tab">Preview</button>
              <button role="tab">Code</button>
            </div>
            <div role="tabpanel">
              <p>Panel content</p>
            </div>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('Preview'),
      'Tab trigger text should be removed'
    );
    assert.ok(!result.includes('Code'), 'Tab trigger text should be removed');
    assert.ok(
      result.includes('Panel content'),
      'Tab panel content should be preserved'
    );
  });
});

describe('Table cell pipe escaping', () => {
  it('escapes pipe characters inside code within table cells', () => {
    const html = `
      <html>
        <body>
          <main>
            <table>
              <tr>
                <td>Type</td>
                <td><code>'horizontal' | 'vertical'</code></td>
              </tr>
            </table>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes("'horizontal' | 'vertical'"),
      'Unescaped pipes in table code should be escaped'
    );
    assert.ok(
      result.includes('\\|') || result.includes('horizontal'),
      'Escaped pipe or content should be present'
    );
  });
});

describe('Badge element separation', () => {
  it('separates adjacent badge spans with whitespace', () => {
    const html = `
      <html>
        <body>
          <main>
            <div>
              <span class="chakra-badge">AI Tip</span><span>Want to skip</span>
            </div>
          </main>
        </body>
      </html>
    `;

    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');

    assert.ok(
      !result.includes('AI TipWant'),
      'Badge text should not concatenate with next element'
    );
  });
});
