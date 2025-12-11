/**
 * Card link extraction utilities for preserving card-style navigation
 * from documentation sites before Readability strips them.
 */

const NOISE_SELECTORS = 'style, svg, [class*="icon"], [aria-hidden="true"]';

/**
 * Clean element by removing noise (styles, SVGs, icons)
 */
function cleanElement(element: Element): Element {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());
  return clone;
}

/**
 * Extract clean title from a card-like link element
 */
function extractCardTitle(link: Element): string | null {
  const clone = cleanElement(link);

  // Look for the first div child which typically contains the title in card layouts
  for (const div of clone.querySelectorAll('div')) {
    if (div.querySelector('div')) continue; // Skip container divs

    const text = div.textContent.trim();
    if (
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
    if (title.length > 1 && title.length < 100) return title;
  }

  // Fall back to first meaningful text content
  const text = clone.textContent.trim().replace(/\s+/g, ' ');
  if (!text || text.length <= 1 || text.length >= 100) return null;

  // Extract title part (first word/phrase before description)
  const words = text.split(/(?=Use |Try |Learn |Get )/);
  if (words.length > 1 && words[0]) return words[0].trim();

  const firstLine = text
    .split(/[.\n]/)
    .find((s) => s.trim().length > 1)
    ?.trim();
  return firstLine ?? text;
}

/**
 * Extract description from a card-like link element
 */
function extractCardDescription(link: Element): string | null {
  const clone = cleanElement(link);

  const descEl = clone.querySelector(
    'p, [class*="description"], [class*="muted"]'
  );
  if (descEl) {
    const desc = descEl.textContent.trim();
    if (desc.length > 5 && desc.length < 200) return desc;
  }

  const text = clone.textContent.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  const descMatch = /(Use |Try |Learn |Get ).*$/.exec(text);
  if (descMatch && descMatch[0].length > 10) return descMatch[0];

  return null;
}

/**
 * Create a list item with link and optional description
 * Formats as markdown-style link to preserve href for AI parsing
 */
function createLinkListItem(
  document: Document,
  href: string,
  title: string,
  description?: string | null
): HTMLLIElement {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.setAttribute('href', href);
  link.textContent = title;
  li.appendChild(link);

  if (description && description !== title && !title.includes(description)) {
    li.appendChild(document.createTextNode(` - ${description}`));
  }

  return li;
}

/**
 * Process custom <card> elements (used by MDX-based docs)
 */
function processCustomCards(document: Document): void {
  const customCards = document.querySelectorAll('card[href], card[title]');
  if (customCards.length === 0) return;

  const list = document.createElement('ul');
  list.setAttribute('data-preserved-cards', 'true');

  for (const card of customCards) {
    const href = card.getAttribute('href');
    const title = card.getAttribute('title') ?? card.textContent.trim();

    if (href && title) {
      const desc = card.querySelector('p')?.textContent.trim();
      list.appendChild(createLinkListItem(document, href, title, desc));
    }
  }

  if (list.children.length > 0) {
    const firstCard = customCards[0];
    firstCard?.parentNode?.insertBefore(list, firstCard);
    customCards.forEach((card) => card.remove());
  }
}

/**
 * Process CSS grid card containers
 */
function processCardGrids(document: Document): void {
  for (const div of document.querySelectorAll('div')) {
    const childLinks = Array.from(div.children).filter(
      (child) => child.tagName === 'A' && child.hasAttribute('href')
    );

    if (childLinks.length < 2) continue;

    const looksLikeCards = childLinks.every((link) => {
      const hasStructuredContent = link.querySelector('svg, div, p, span');
      const hasReasonableText = link.textContent.trim().length > 3;
      return hasStructuredContent && hasReasonableText;
    });

    if (!looksLikeCards) continue;

    const section = document.createElement('div');
    section.setAttribute('data-preserved-cards', 'true');
    const list = document.createElement('ul');

    for (const link of childLinks) {
      const href = link.getAttribute('href');
      const title = extractCardTitle(link);
      const desc = extractCardDescription(link);

      if (href && title) {
        list.appendChild(createLinkListItem(document, href, title, desc));
      }
    }

    if (list.children.length > 0) {
      section.appendChild(list);
      div.parentNode?.replaceChild(section, div);
    }
  }
}

/**
 * Process semantic card containers
 */
function processSemanticCards(document: Document): void {
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
      for (const container of document.querySelectorAll(selector)) {
        const links = container.querySelectorAll('a[href]');
        if (links.length === 0) continue;

        const list = document.createElement('ul');
        list.setAttribute('data-preserved-cards', 'true');

        for (const link of links) {
          const href = link.getAttribute('href');
          const title = extractCardTitle(link);

          if (href && title) {
            list.appendChild(createLinkListItem(document, href, title));
          }
        }

        if (list.children.length > 0) {
          container.parentNode?.replaceChild(list, container);
        }
      }
    } catch {
      // Selector might be invalid, skip it
    }
  }
}

/**
 * Pre-process HTML to preserve card links that Readability might strip.
 * Converts card-like elements into simple link lists.
 */
export function preserveCardLinks(document: Document): void {
  processCustomCards(document);
  processCardGrids(document);
  processSemanticCards(document);
}
