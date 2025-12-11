import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { JSDOM } from 'jsdom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types.js';

import { logError, logWarn } from './logger.js';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

/**
 * Extract metadata using Cheerio (fast, no full DOM)
 * This avoids JSDOM overhead for simple meta tag extraction
 */
function extractMetadataWithCheerio($: CheerioAPI): ExtractedMetadata {
  const getMetaContent = (selectors: string[]): string | undefined => {
    for (const selector of selectors) {
      const content = $(selector).attr('content');
      if (content) return content;
    }
    return undefined;
  };

  const title =
    getMetaContent([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ??
    ($('title').text() || undefined);

  const description = getMetaContent([
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  const author = getMetaContent([
    'meta[name="author"]',
    'meta[property="article:author"]',
  ]);

  return { title, description, author };
}

/**
 * Extract clean title from a card-like link element
 * Handles complex structures with SVGs, icons, nested elements, and inline styles
 */
function extractCardTitle(link: Element): string | null {
  // Clone the link to avoid modifying the original
  const clone = link.cloneNode(true) as Element;

  // Remove style tags, SVGs, icons, and arrow indicators
  clone
    .querySelectorAll('style, svg, [class*="icon"], [aria-hidden="true"]')
    .forEach((el) => el.remove());

  // Look for the first div child which typically contains the title in card layouts
  const divs = clone.querySelectorAll('div');
  for (const div of divs) {
    // Skip divs that contain other divs (container divs)
    if (div.querySelector('div')) continue;

    const text = div.textContent.trim();
    // Title is typically short and doesn't contain "Use" or other description words
    if (
      text &&
      text.length > 1 &&
      text.length < 50 &&
      !text.includes(' with ') &&
      !text.includes('Use ')
    ) {
      return text;
    }
  }

  // Look for structured title elements
  const titleEl = clone.querySelector(
    '[class*="title"], h2, h3, h4, h5, strong'
  );
  if (titleEl) {
    const title = titleEl.textContent.trim();
    if (title && title.length > 1 && title.length < 100) {
      return title;
    }
  }

  // Fall back to first meaningful text content
  const text = clone.textContent.trim().replace(/\s+/g, ' ');
  if (text && text.length > 1 && text.length < 100) {
    // Extract just the title part (usually the first word/phrase before description)
    const words = text.split(/(?=Use |Try |Learn |Get )/);
    if (words.length > 1 && words[0]) {
      return words[0].trim();
    }
    const firstLine = text
      .split(/[.\n]/)
      .find((s) => s.trim().length > 1)
      ?.trim();
    return firstLine ?? text;
  }

  return null;
}

/**
 * Extract description from a card-like link element
 */
function extractCardDescription(link: Element): string | null {
  // Clone to avoid modifying original
  const clone = link.cloneNode(true) as Element;

  // Remove style tags, SVGs and icons
  clone
    .querySelectorAll('style, svg, [class*="icon"], [aria-hidden="true"]')
    .forEach((el) => el.remove());

  // Look for description in p tags or elements with muted/description in class
  const descEl = clone.querySelector(
    'p, [class*="description"], [class*="muted"]'
  );
  if (descEl) {
    const desc = descEl.textContent.trim();
    if (desc && desc.length > 5 && desc.length < 200) {
      return desc;
    }
  }

  // Try to extract description from text that follows common patterns
  const text = clone.textContent.trim().replace(/\s+/g, ' ');
  if (text) {
    // Look for text after the title pattern (e.g., "Use Chakra UI with...")
    const descMatch = /(Use |Try |Learn |Get ).*$/.exec(text);
    if (descMatch && descMatch[0].length > 10) {
      return descMatch[0];
    }
  }

  return null;
}

/**
 * Pre-process HTML to preserve card links that Readability might strip
 * Converts card-like elements into simple link lists
 */
function preserveCardLinks(document: Document): void {
  // Handle custom <card> elements (used by some MDX-based docs)
  const customCards = document.querySelectorAll('card[href], card[title]');
  if (customCards.length > 0) {
    const list = document.createElement('ul');
    list.setAttribute('data-preserved-cards', 'true');

    customCards.forEach((card) => {
      const href = card.getAttribute('href');
      const title = card.getAttribute('title') ?? card.textContent.trim();

      if (href && title) {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.setAttribute('href', href);
        link.textContent = title;
        li.appendChild(link);

        // Add description if present
        const desc = card.querySelector('p')?.textContent.trim();
        if (desc && desc !== title) {
          li.appendChild(document.createTextNode(` - ${desc}`));
        }

        list.appendChild(li);
      }
    });

    if (list.children.length > 0) {
      const firstCard = customCards[0];
      if (firstCard?.parentNode) {
        firstCard.parentNode.insertBefore(list, firstCard);
      }
      customCards.forEach((card) => card.remove());
    }
  }

  // Find card grid containers: divs with CSS grid layout containing multiple card-like links
  // This handles sites like Chakra UI that use CSS-in-JS with generated class names
  const allDivs = document.querySelectorAll('div');
  allDivs.forEach((div) => {
    // Check if this div contains multiple direct child anchor tags (card pattern)
    const childLinks = Array.from(div.children).filter(
      (child) => child.tagName === 'A' && child.hasAttribute('href')
    );

    // Need at least 2 card-like links to be considered a card grid
    if (childLinks.length < 2) return;

    // Verify these look like cards (have structured content, not just text links)
    const looksLikeCards = childLinks.every((link) => {
      const hasStructuredContent = link.querySelector('svg, div, p, span');
      const hasReasonableText = link.textContent.trim().length > 3;
      return hasStructuredContent && hasReasonableText;
    });

    if (!looksLikeCards) return;

    // Create a preserved links section
    const section = document.createElement('div');
    section.setAttribute('data-preserved-cards', 'true');

    const list = document.createElement('ul');

    childLinks.forEach((link) => {
      const href = link.getAttribute('href');
      const title = extractCardTitle(link);
      const desc = extractCardDescription(link);

      if (href && title) {
        const li = document.createElement('li');
        const newLink = document.createElement('a');
        newLink.setAttribute('href', href);
        newLink.textContent = title;
        li.appendChild(newLink);

        if (desc && desc !== title && !title.includes(desc)) {
          li.appendChild(document.createTextNode(` - ${desc}`));
        }

        list.appendChild(li);
      }
    });

    if (list.children.length > 0) {
      section.appendChild(list);
      // Replace the card grid with our simple list
      if (div.parentNode) {
        div.parentNode.replaceChild(section, div);
      }
    }
  });

  // Also handle common card container selectors for semantic sites
  const cardSelectors = [
    '[class*="card-group"]',
    '[class*="card-grid"]',
    '[class*="cards"]',
    '[data-cards]',
    '[class*="link-card"]',
    '[class*="feature-card"]',
  ];

  for (const selector of cardSelectors) {
    try {
      const containers = document.querySelectorAll(selector);
      containers.forEach((container) => {
        const links = container.querySelectorAll('a[href]');
        if (links.length === 0) return;

        const list = document.createElement('ul');
        list.setAttribute('data-preserved-cards', 'true');

        links.forEach((link) => {
          const href = link.getAttribute('href');
          const title = extractCardTitle(link);

          if (href && title) {
            const li = document.createElement('li');
            const newLink = document.createElement('a');
            newLink.setAttribute('href', href);
            newLink.textContent = title;
            li.appendChild(newLink);
            list.appendChild(li);
          }
        });

        if (list.children.length > 0 && container.parentNode) {
          container.parentNode.replaceChild(list, container);
        }
      });
    } catch {
      // Selector might be invalid, skip it
    }
  }
}

/**
 * Extract article content using JSDOM + Readability
 * Only called when extractMainContent is true (lazy loading)
 */
function extractArticleWithJsdom(
  html: string,
  url: string
): ExtractedArticle | null {
  // Suppress CSS parsing errors from jsdom (modern CSS features cause warnings)
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const message = args[0];
    if (
      typeof message === 'string' &&
      message.includes('Could not parse CSS stylesheet')
    ) {
      return; // Suppress CSS parsing errors
    }
    originalConsoleError.apply(console, args);
  };

  try {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Pre-process to preserve card links before Readability strips them
    preserveCardLinks(document);
    // Readability mutates document, but we don't need to clone since
    // we create a fresh JSDOM instance and don't reuse the document
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) return null;

    return {
      title: article.title ?? undefined,
      byline: article.byline ?? undefined,
      content: article.content ?? '',
      textContent: article.textContent ?? '',
      excerpt: article.excerpt ?? undefined,
      siteName: article.siteName ?? undefined,
    };
  } catch (error) {
    logError(
      'Failed to extract article with JSDOM',
      error instanceof Error ? error : undefined
    );
    return null;
  } finally {
    // Restore original console.error
    console.error = originalConsoleError;
  }
}

/**
 * Extract metadata only using Cheerio (fast path)
 * Use this when you don't need article extraction
 */
export function extractMetadataOnly(html: string): ExtractedMetadata {
  if (!html || typeof html !== 'string') {
    return {};
  }

  try {
    const $ = cheerio.load(html);
    return extractMetadataWithCheerio($);
  } catch {
    return {};
  }
}

/**
 * Main extraction function - uses Cheerio for metadata (fast)
 * and lazy-loads JSDOM only when article extraction is needed
 */
export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean } = { extractArticle: true }
): ExtractionResult {
  if (!html || typeof html !== 'string') {
    logWarn('extractContent called with invalid HTML input');
    return { article: null, metadata: {} };
  }

  if (!url || typeof url !== 'string') {
    logWarn('extractContent called with invalid URL');
    return { article: null, metadata: {} };
  }

  let processedHtml = html;
  if (html.length > MAX_HTML_SIZE) {
    logWarn('HTML content exceeds maximum size for extraction, truncating', {
      size: html.length,
      maxSize: MAX_HTML_SIZE,
    });
    processedHtml = html.substring(0, MAX_HTML_SIZE);
  }

  try {
    // Fast path: Extract metadata with Cheerio (no full DOM parsing)
    const $ = cheerio.load(processedHtml);
    const metadata = extractMetadataWithCheerio($);

    // Lazy path: Only use JSDOM when article extraction is requested
    const article = options.extractArticle
      ? extractArticleWithJsdom(processedHtml, url)
      : null;

    return { article, metadata };
  } catch (error) {
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
  }
}
