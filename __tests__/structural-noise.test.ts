import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../src/lib/core.js';
import { removeNoiseFromHtml } from '../src/transform/index.js';

// Helper: wraps content in a minimal HTML page with enough main content
// so that body innerHTML > 100 chars after noise removal (MIN_BODY_CONTENT_LENGTH).
function page(bodyContent: string): string {
  return `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>${bodyContent}</body></html>`;
}

// ── Structural tag removal ──────────────────────────────────────────

describe('Structural tag removal', () => {
  it('removes <script> tags and their content', () => {
    const html = page('<script>alert("xss")</script>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('alert'), 'Script content must be removed');
    assert.ok(
      result.includes('main article content'),
      'Main content preserved'
    );
  });

  it('removes <style> tags and their content', () => {
    const html = page('<style>body { color: red; }</style>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('color: red'), 'Style content must be removed');
  });

  it('removes <iframe> elements', () => {
    const html = page('<iframe src="https://ads.example.com/banner"></iframe>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('iframe'), 'Iframe must be removed');
  });

  it('removes <form> elements outside primary content', () => {
    const html = page(
      '<form action="/subscribe"><input type="email"/><button>Go</button></form>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('subscribe'), 'Form must be removed');
  });

  it('removes <input>, <select>, <textarea> elements', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <input type="text" value="search"/>
      <select><option>Pick</option></select>
      <textarea>Notes</textarea>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('<input'), 'Input must be removed');
    assert.ok(!result.includes('<select'), 'Select must be removed');
    assert.ok(!result.includes('<textarea'), 'Textarea must be removed');
  });

  it('removes <svg> and <canvas> by default (preserveSvgCanvas=false)', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>
      <canvas id="chart"></canvas>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('<svg'), 'SVG must be removed by default');
    assert.ok(!result.includes('<canvas'), 'Canvas must be removed by default');
  });

  it('preserves <svg> and <canvas> when preserveSvgCanvas=true', () => {
    const original = config.noiseRemoval.preserveSvgCanvas;
    config.noiseRemoval.preserveSvgCanvas = true;
    try {
      const html = `<html><body><main>
        <p>Content</p>
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>
        <canvas id="chart"></canvas>
      </main></body></html>`;
      const result = removeNoiseFromHtml(
        html,
        undefined,
        'https://example.com'
      );
      assert.ok(
        result.includes('<svg') || result.includes('circle'),
        'SVG must be preserved when config enabled'
      );
    } finally {
      config.noiseRemoval.preserveSvgCanvas = original;
    }
  });
});

// ── ARIA role-based noise ───────────────────────────────────────────

describe('ARIA role-based noise removal', () => {
  it('removes role="navigation" elements', () => {
    const html = page(
      '<div role="navigation"><a href="/">Home</a><a href="/about">About</a></div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('role="navigation"'),
      'Navigation role must be removed'
    );
  });

  it('removes role="banner" elements', () => {
    const html = page('<div role="banner"><p>Site banner content</p></div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Site banner content'),
      'Banner role content must be removed'
    );
  });

  it('removes role="contentinfo" elements', () => {
    const html = page('<div role="contentinfo"><p>Footer info</p></div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Footer info'),
      'Contentinfo role must be removed'
    );
  });

  it('removes role="menubar" elements', () => {
    const html = page(
      '<div role="menubar"><span>File</span><span>Edit</span></div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('role="menubar"'),
      'Menubar role must be removed'
    );
  });

  it('removes role="search" elements', () => {
    const html = page(
      '<div role="search"><input type="text"/><button>Search</button></div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('role="search"'), 'Search role must be removed');
  });

  it('removes role="menu" elements', () => {
    const html = page('<ul role="menu"><li>Item 1</li><li>Item 2</li></ul>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('role="menu"'), 'Menu role must be removed');
  });

  it('removes role="tree" elements', () => {
    const html = page('<ul role="tree"><li role="treeitem">Node 1</li></ul>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('role="tree"'), 'Tree role must be removed');
  });
});

// ── Hidden attribute removal ────────────────────────────────────────

describe('Hidden attribute removal', () => {
  it('removes elements with [hidden] attribute', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div hidden><p>Hidden content</p></div></body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('Hidden content'), '[hidden] must be removed');
    assert.ok(
      result.includes('main article content'),
      'Visible content preserved'
    );
  });

  it('removes elements with aria-hidden="true"', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div aria-hidden="true"><p>Screen reader hidden</p></div></body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Screen reader hidden'),
      'aria-hidden must be removed'
    );
  });
});

// ── Promo token categories ──────────────────────────────────────────

describe('Promo token categories', () => {
  it('removes cookie consent elements when category enabled', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div class="cookie-consent"><p>We use cookies</p><button>Accept</button></div>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('We use cookies'),
      'Cookie consent must be removed'
    );
  });

  it('removes newsletter subscribe elements', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div class="newsletter-signup"><p>Subscribe to updates</p></div>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Subscribe to updates'),
      'Newsletter must be removed'
    );
  });

  it('removes aggressive promo tokens when aggressiveMode=true', () => {
    const originalAggressive = config.noiseRemoval.aggressiveMode;
    config.noiseRemoval.aggressiveMode = true;
    try {
      const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
        <div class="related-posts"><p>You may also like</p></div>
      </body></html>`;
      const result = removeNoiseFromHtml(
        html,
        undefined,
        'https://example.com'
      );
      assert.ok(
        !result.includes('You may also like'),
        'Related posts must be removed in aggressive mode'
      );
    } finally {
      config.noiseRemoval.aggressiveMode = originalAggressive;
    }
  });

  it('removes breadcrumb elements', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div class="breadcrumb"><a href="/">Home</a> &gt; <a href="/docs">Docs</a></div>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('breadcrumb'), 'Breadcrumb must be removed');
  });

  it('removes sponsor/advert elements', () => {
    const html = `<html><body><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes.</p></main>
      <div class="sponsor-banner"><p>Sponsored by Example Corp</p></div>
    </body></html>`;
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Sponsored by'),
      'Sponsor banner must be removed'
    );
  });
});

// ── Complex element preservation ──────────────────────────────────────

describe('Complex element preservation', () => {
  it('removes small <nav> and <footer> tags', () => {
    const html = page(
      '<nav>Link 1</nav><footer><p>Copyright 2024</p></footer>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('Link 1'), '<nav> must be removed when small');
    assert.ok(
      !result.includes('Copyright'),
      '<footer> must be removed when small'
    );
  });

  it('preserves <nav> and <footer> tags with > 500 characters', () => {
    const longText = 'x'.repeat(600);
    const html = page(
      '<nav>' + longText + '</nav><footer>' + longText + '</footer>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    const navMatch = result.match(/<nav/);
    const footerMatch = result.match(/<footer/);
    assert.ok(navMatch !== null, '<nav> must be preserved when large');
    assert.ok(footerMatch !== null, '<footer> must be preserved when large');
  });

  it('removes <aside>', () => {
    const html = page('<aside><p>Sidebar info.</p></aside>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('Sidebar info.'), '<aside> must be removed');
  });

  it('preserves <aside> if it is primary content', () => {
    const html =
      '<html><body><aside><main><p>This is the main article content that must be preserved through noise removal for proper testing purposes. ' +
      'x'.repeat(100) +
      '</p></main></aside></body></html>';
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes('This is the main article'),
      'Main content must be preserved inside <aside>'
    );
  });

  it('removes dialogs when small and not containing headings', () => {
    const html = page('<div role="dialog"><p>Cookie consent</p></div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Cookie consent'),
      'Small dialog must be removed'
    );
  });

  it('preserves dialogs containing a heading', () => {
    const html = page(
      '<div role="dialog"><h2>Important</h2><p>Message</p></div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes('Message'),
      'Dialog with heading must be preserved'
    );
  });

  it('preserves large dialogs', () => {
    const longText = 'x'.repeat(600);
    const html = page('<div role="dialog"><p>' + longText + '</p></div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(result.includes(longText), 'Large dialog must be preserved');
  });
});

// ── Positional noise removal ──────────────────────────────────────────

describe('Positional noise removal', () => {
  it('removes elements with fixed/sticky positioning and z-index classes', () => {
    const html = page(
      '<div class="fixed top-0">Fixed top</div>' +
        '<div class="sticky top-0">Sticky top</div>' +
        '<div class="z-50 modal">High z-index</div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(!result.includes('Fixed top'), 'fixed element must be removed');
    assert.ok(!result.includes('Sticky top'), 'sticky element must be removed');
    assert.ok(!result.includes('High z-index'), 'z-50 element must be removed');
  });

  it('preserves large positional elements', () => {
    const longText = 'x'.repeat(600);
    const html = page('<div class="fixed top-0">' + longText + '</div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes(longText),
      'large positional element must be preserved'
    );
  });
});

// ── Interactive custom element states ─────────────────────────────────

describe('Interactive custom element states', () => {
  it('preserves elements with data-state="inactive" or "closed"', () => {
    const html = page(
      '<div data-state="inactive">Inactive element</div>' +
        '<div data-state="closed">Closed element</div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes('Inactive element'),
      'Inactive element must be preserved'
    );
    assert.ok(
      result.includes('Closed element'),
      'Closed element must be preserved'
    );
  });

  it('preserves elements with data-orientation', () => {
    const html = page(
      '<div data-orientation="horizontal">Horizontal element</div>'
    );
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes('Horizontal element'),
      'data-orientation element must be preserved'
    );
  });

  it('preserves elements with data-accordion-item', () => {
    const html = page('<div data-accordion-item>Accordion item</div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      result.includes('Accordion item'),
      'Accordion item must be preserved'
    );
  });
});

// ── Configuration overrides ───────────────────────────────────────────

describe('Configuration overrides', () => {
  it('removes custom tokens specified in extraTokens', () => {
    const originalTokens = config.noiseRemoval.extraTokens;
    config.noiseRemoval.extraTokens = ['my-custom-promo'];
    const html = page('<div class="my-custom-promo">Custom promo text</div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Custom promo text'),
      'Custom promo token should be applied'
    );
    config.noiseRemoval.extraTokens = originalTokens;
  });

  it('removes custom selectors specified in extraSelectors', () => {
    const originalSelectors = config.noiseRemoval.extraSelectors;
    config.noiseRemoval.extraSelectors = ['#my-custom-sidebar'];
    const html = page('<div id="my-custom-sidebar">Sidebar content</div>');
    const result = removeNoiseFromHtml(html, undefined, 'https://example.com');
    assert.ok(
      !result.includes('Sidebar content'),
      'Custom selector should be applied'
    );
    config.noiseRemoval.extraSelectors = originalSelectors;
  });
});
