import { parseHTML } from 'linkedom';

import { config, logDebug } from './core.js';

// ── Thresholds ──────────────────────────────────────────────────────
const NOISE_SCAN_LIMIT = 50_000;
const MIN_BODY_CONTENT_LENGTH = 100;
const DIALOG_MIN_CHARS_FOR_PRESERVATION = 500;
const NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION = 500;
const ABORT_CHECK_INTERVAL = 500;
const NODE_FILTER_SHOW_TEXT = 4;
const ASIDE_NAV_LINK_DENSITY_THRESHOLD = 0.5;
const ASIDE_NAV_MIN_LINKS = 10;
const INLINE_DEMO_INSTRUCTION_MAX_CHARS = 160;
const REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS = 60;
const REDUNDANT_PREVIEW_MAX_SEGMENTS = 12;

// ── Regex patterns ──────────────────────────────────────────────────
const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
const HTML_FRAGMENT_MARKERS =
  /<\s*(?:article|main|section|div|nav|footer|header|aside|table|ul|ol)\b/i;
const NOISE_PATTERNS: readonly RegExp[] = [
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i,
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i,
  /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i,
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast)\b/i,
  /[\s"'](?:fixed|sticky|z-50|z-4|isolate|breadcrumbs?|pagination)\b/i,
];
const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_OR_HIGH_Z_PATTERN = /\b(?:fixed|sticky|z-(?:4\d|50)|isolate)\b/;
const HEADING_PERMALINK_TEXT_PATTERN = /^(?:#|¶|§|¤|🔗)$/u;
const HEADING_PERMALINK_CLASS_PATTERN =
  /\b(?:mark|permalink|hash-link|anchor(?:js)?-?link|header-?link|heading-anchor|deep-link)\b/i;
const HIDDEN_STYLE_REGEX =
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const DISPLAY_NONE_REGEX = /display\s*:\s*none/i;
const DISPLAY_NONE_STRIP_REGEX = /display\s*:\s*none\s*;?/gi;
const UTM_PARAM_REGEX = /[?&]utm_(?:source|medium|campaign)=/i;
const NO_MATCH_REGEX = /a^/i;

// ── URL prefixes to skip during resolution ──────────────────────────
const SKIP_URL_PREFIXES = [
  '#',
  'javascript:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
];

// ── Tag / role sets ─────────────────────────────────────────────────
const BASE_STRUCTURAL_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'template',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);
const ALWAYS_NOISE_TAGS = new Set(['nav', 'footer']);
const NAVIGATION_ROLES = new Set([
  'navigation',
  'banner',
  'complementary',
  'contentinfo',
  'tree',
  'menubar',
  'menu',
  'dialog',
  'alertdialog',
  'search',
]);
const INTERACTIVE_CONTENT_ROLES = new Set([
  'tabpanel',
  'tab',
  'tablist',
  'dialog',
  'alertdialog',
  'menu',
  'menuitem',
  'option',
  'listbox',
  'combobox',
  'tooltip',
  'alert',
]);

// ── Promo tokens ────────────────────────────────────────────────────
const PROMO_TOKENS_ALWAYS = [
  'banner',
  'promo',
  'announcement',
  'cta',
  'advert',
  'ads',
  'sponsor',
  'recommend',
  'breadcrumb',
  'breadcrumbs',
  'pagination',
  'pager',
  'taglist',
  'twitter-tweet',
  'fb-post',
  'instagram-media',
  'social-embed',
  'author-bio',
  'byline',
  'sharedaddy',
  'sharing',
];
const PROMO_TOKENS_AGGRESSIVE = ['ad', 'related', 'comment'];
const PROMO_TOKENS_BY_CATEGORY: Record<string, string[]> = {
  'cookie-banners': ['cookie', 'consent', 'popup', 'modal', 'overlay', 'toast'],
  newsletters: ['newsletter', 'subscribe'],
  'social-share': ['share', 'social', 'share-button'],
  'author-blocks': ['author-bio', 'byline', 'author-info', 'writer-profile'],
  'related-content': [
    'related-post',
    'related-article',
    'more-stories',
    'recommended-posts',
  ],
};

// ── Noise selector configurations ───────────────────────────────────
const BASE_NOISE_SELECTORS = {
  navFooter:
    'nav,footer,header[class*="site"],header[class*="nav"],header[class*="menu"],[role="banner"],[role="navigation"],[class*="breadcrumb"]',
  cookieBanners: '[role="dialog"]',
  hidden:
    '[style*="display: none"],[style*="display:none"],[style*="visibility: hidden"],[style*="visibility:hidden"],[hidden],[aria-hidden="true"]',
};

// ── Types ───────────────────────────────────────────────────────────
type NoiseRemovalConfig = (typeof config)['noiseRemoval'];
interface PromoTokenMatchers {
  readonly base: RegExp;
  readonly aggressive: RegExp;
}
interface NoiseContext {
  readonly flags: {
    readonly navFooter: boolean;
    readonly cookieBanners: boolean;
  };
  readonly structuralTags: Set<string>;
  readonly promoMatchers: PromoTokenMatchers;
  readonly promoEnabled: boolean;
  readonly noiseSelector: string;
  readonly extraSelector: string | null;
  readonly candidateSelector: string;
}

let cachedContext: NoiseContext | undefined;
let lastContextKey: string | undefined;

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildTokenRegex(tokens: Set<string>): RegExp {
  if (tokens.size === 0) return NO_MATCH_REGEX;
  return new RegExp(
    `(?:^|[^a-z0-9])(?:${[...tokens].map(escapeRegexLiteral).join('|')})(?:$|[^a-z0-9])`,
    'i'
  );
}
function getPromoMatchers(
  currentConfig: NoiseRemovalConfig,
  enabledCategories: Set<string>
): PromoTokenMatchers {
  const baseTokens = new Set(PROMO_TOKENS_ALWAYS);
  const aggressiveTokens = new Set<string>();

  if (currentConfig.aggressiveMode) {
    for (const token of PROMO_TOKENS_AGGRESSIVE) aggressiveTokens.add(token);
  }

  for (const [category, tokens] of Object.entries(PROMO_TOKENS_BY_CATEGORY)) {
    if (enabledCategories.has(category)) {
      for (const token of tokens) baseTokens.add(token);
    }
  }

  for (const t of currentConfig.extraTokens) {
    const n = t.toLowerCase().trim();
    if (n) baseTokens.add(n);
  }

  return {
    base: buildTokenRegex(baseTokens),
    aggressive: buildTokenRegex(aggressiveTokens),
  };
}
function getContext(): NoiseContext {
  const currentConfig = config.noiseRemoval;
  const contextKey = JSON.stringify({
    locale: config.i18n.locale,
    enabledCategories: currentConfig.enabledCategories,
    extraTokens: currentConfig.extraTokens,
    extraSelectors: currentConfig.extraSelectors,
    aggressiveMode: currentConfig.aggressiveMode,
    preserveSvgCanvas: currentConfig.preserveSvgCanvas,
  });
  if (cachedContext !== undefined && lastContextKey === contextKey)
    return cachedContext;

  const enabled = new Set(
    currentConfig.enabledCategories
      .map((c) => {
        const s = c.toLowerCase().trim();
        const { locale } = config.i18n;
        return locale ? s.toLocaleLowerCase(locale) : s;
      })
      .filter(Boolean)
  );

  const isEnabled = (cat: string): boolean => enabled.has(cat);
  const flags = {
    navFooter: isEnabled('nav-footer'),
    cookieBanners: isEnabled('cookie-banners'),
  };

  const structuralTags = new Set(BASE_STRUCTURAL_TAGS);
  if (!currentConfig.preserveSvgCanvas) {
    structuralTags.add('svg');
    structuralTags.add('canvas');
  }

  const promoMatchers = getPromoMatchers(currentConfig, enabled);
  const extraSelectors = currentConfig.extraSelectors
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Pre-build selectors
  const selectors = [BASE_NOISE_SELECTORS.hidden];
  if (flags.navFooter) selectors.push(BASE_NOISE_SELECTORS.navFooter);
  if (flags.cookieBanners) selectors.push(BASE_NOISE_SELECTORS.cookieBanners);
  const noiseSelector = selectors.join(',');
  const extraSelector =
    extraSelectors.length > 0 ? extraSelectors.join(',') : null;

  const candidateSelector = [
    ...structuralTags,
    ...ALWAYS_NOISE_TAGS,
    'aside',
    'header',
    '[class]',
    '[id]',
    '[role]',
    '[style]',
  ].join(',');

  cachedContext = {
    flags,
    structuralTags,
    promoMatchers,
    promoEnabled: Object.keys(PROMO_TOKENS_BY_CATEGORY).some((cat) =>
      enabled.has(cat)
    ),
    noiseSelector,
    extraSelector,
    candidateSelector,
  };
  lastContextKey = contextKey;
  return cachedContext;
}
function isInteractive(element: Element, role: string | null): boolean {
  if (role && INTERACTIVE_CONTENT_ROLES.has(role)) return true;
  const tag = element.tagName.toLowerCase();
  const ds = element.getAttribute('data-state');
  if ((ds === 'inactive' || ds === 'closed') && !BASE_STRUCTURAL_TAGS.has(tag))
    return true;
  const dataOrientation = element.getAttribute('data-orientation');
  if (dataOrientation === 'horizontal' || dataOrientation === 'vertical')
    return true;
  return (
    element.hasAttribute('data-accordion-item') ||
    element.hasAttribute('data-radix-collection-item')
  );
}
function isWithinPrimaryContent(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const tagName = current.tagName.toLowerCase();
    if (tagName === 'article' || tagName === 'main') return true;
    if (current.getAttribute('role') === 'main') return true;
    current = current.parentElement;
  }
  return false;
}
function isNavigationAside(element: Element): boolean {
  if (element.querySelector('nav')) return true;
  const links = element.querySelectorAll('a[href]');
  if (links.length < ASIDE_NAV_MIN_LINKS) return false;
  const textLen = (element.textContent || '').trim().length;
  if (textLen === 0) return true;
  return links.length / (textLen / 100) >= ASIDE_NAV_LINK_DENSITY_THRESHOLD;
}
function shouldPreserve(element: Element, tagName: string): boolean {
  // Check Dialog
  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') {
    if (isWithinPrimaryContent(element)) return true;
    const textLen = (element.textContent || '').length;
    if (textLen > DIALOG_MIN_CHARS_FOR_PRESERVATION) return true;
    return element.querySelector('h1,h2,h3,h4,h5,h6') !== null;
  }

  // Check Nav/Footer
  if (tagName === 'nav' || tagName === 'footer') {
    if (element.querySelector('article,main,section,[role="main"]'))
      return true;
    return (
      (element.textContent || '').trim().length >=
      NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION
    );
  }

  // Check Aside — preserve only if it looks like article content, not navigation
  if (tagName === 'aside') {
    if (!isWithinPrimaryContent(element)) return false;
    return !isNavigationAside(element);
  }

  return false;
}
function removeNodes(nodes: ArrayLike<Element>): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node?.parentNode && !shouldPreserve(node, node.tagName.toLowerCase())) {
      node.remove();
    }
  }
}

function isPromoMatch(
  className: string,
  id: string,
  element: Element,
  context: NoiseContext
): boolean {
  if (!context.promoEnabled) return false;
  const aggTest =
    context.promoMatchers.aggressive.test(className) ||
    context.promoMatchers.aggressive.test(id);
  if (aggTest) return !isWithinPrimaryContent(element);
  return (
    context.promoMatchers.base.test(className) ||
    context.promoMatchers.base.test(id)
  );
}

function isNoiseElement(element: Element, context: NoiseContext): boolean {
  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const className = element.getAttribute('class') ?? '';
  const id = element.getAttribute('id') ?? '';
  const interactive = isInteractive(element, role);
  const style = element.getAttribute('style');
  const hidden =
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    (style !== null && HIDDEN_STYLE_REGEX.test(style));

  // Structural tags (script, style, form, etc.)
  if (context.structuralTags.has(tagName) && !interactive) return true;

  if (context.flags.navFooter) {
    // Always-noise tags (nav, footer)
    if (ALWAYS_NOISE_TAGS.has(tagName)) return true;
    // Header with navigation role or noise class/id
    if (
      tagName === 'header' &&
      ((role !== null && NAVIGATION_ROLES.has(role)) ||
        HEADER_NOISE_PATTERN.test(`${className} ${id}`))
    )
      return true;
    // Aside elements
    if (tagName === 'aside') return true;
    // Navigation roles (except aside+complementary)
    if (
      role !== null &&
      NAVIGATION_ROLES.has(role) &&
      (tagName !== 'aside' || role !== 'complementary')
    )
      return true;
  }

  // Hidden elements
  if (hidden && !interactive) return true;

  // Sticky/fixed positioned elements
  if (FIXED_OR_HIGH_Z_PATTERN.test(className)) return true;

  // Promotional/noise content
  if (isPromoMatch(className, id, element, context)) return true;

  return false;
}
function cleanHeadings(document: Document): void {
  const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of headings) {
    if (!h.parentNode) continue;

    // Remove absolute/positioned wrapper divs
    const divs = h.querySelectorAll('div');
    for (let j = divs.length - 1; j >= 0; j--) {
      const d = divs[j];
      if (!d?.parentNode) continue;
      const cls = d.getAttribute('class') ?? '';
      const stl = d.getAttribute('style') ?? '';
      if (
        cls.includes('absolute') ||
        stl.includes('position') ||
        d.getAttribute('tabindex') === '-1'
      ) {
        d.remove();
      }
    }

    // Remove empty hash-link anchors
    const anchors = h.querySelectorAll('a');
    for (let j = anchors.length - 1; j >= 0; j--) {
      const a = anchors[j];
      if (!a?.parentNode) continue;
      if (isHeadingPermalinkAnchor(a)) a.remove();
    }

    // Strip zero-width spaces from text nodes
    const walker = document.createTreeWalker(h, NODE_FILTER_SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.includes('\u200B')) {
        node.textContent = node.textContent.replace(/\u200B/g, '');
      }
    }
  }
}

function getCollapsedHeadingAnchorText(anchor: Element): string {
  return (anchor.textContent || '').replace(/[\u200B\s]/g, '');
}

function isHeadingPermalinkAnchor(anchor: Element): boolean {
  const href = anchor.getAttribute('href') ?? '';
  if (!href.startsWith('#')) return false;

  const text = getCollapsedHeadingAnchorText(anchor);
  if (text.length === 0 || HEADING_PERMALINK_TEXT_PATTERN.test(text)) {
    return true;
  }

  const className = anchor.getAttribute('class') ?? '';
  if (HEADING_PERMALINK_CLASS_PATTERN.test(className) && text.length <= 2) {
    return true;
  }

  const ariaHidden = anchor.getAttribute('aria-hidden');
  const tabindex = anchor.getAttribute('tabindex');
  return (ariaHidden === 'true' || tabindex === '-1') && text.length <= 2;
}

function getDirectRows(section: Element): Element[] {
  return Array.from(section.children).filter((child) => child.tagName === 'TR');
}

function getDirectCells(row: Element): Element[] {
  return Array.from(row.children).filter(
    (child) => child.tagName === 'TH' || child.tagName === 'TD'
  );
}

function hoistNestedRows(table: Element): void {
  const sections = Array.from(table.querySelectorAll('thead,tbody,tfoot'));

  for (const section of sections) {
    const rows = getDirectRows(section);

    for (const row of rows) {
      let insertAfter: Element = row;

      for (const cell of getDirectCells(row)) {
        const nestedRows = Array.from(cell.querySelectorAll('tr')).filter(
          (nested) => nested.closest('table') === table
        );

        for (const nestedRow of nestedRows) {
          insertAfter.after(nestedRow);
          insertAfter = nestedRow;
        }
      }
    }
  }
}
function stripNoise(document: Document, signal?: AbortSignal): void {
  const context = getContext();

  if (config.noiseRemoval.debug) {
    logDebug('Noise removal audit enabled', {
      categories: [...(context.flags.navFooter ? ['nav-footer'] : [])],
    });
  }

  // Structural Removal
  removeNodes(document.querySelectorAll(context.noiseSelector));

  // Extra selectors (evaluated after base removal so DOM state is updated)
  if (context.extraSelector) {
    removeNodes(document.querySelectorAll(context.extraSelector));
  }

  // Candidates (conditional removal)
  const candidates = document.querySelectorAll(context.candidateSelector);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (i % ABORT_CHECK_INTERVAL === 0 && signal?.aborted) {
      throw new Error('Noise removal aborted');
    }
    const node = candidates[i];
    if (!node) continue;
    if (!node.parentNode) continue;

    if (shouldPreserve(node, node.tagName.toLowerCase())) continue;
    if (isNoiseElement(node, context)) {
      node.remove();
    }
  }
}
function processUrlElement(
  el: Element,
  attr: string,
  base: URL,
  isSrcset: boolean
): void {
  if (!el.parentNode) return;
  if (isSrcset) {
    const val = el.getAttribute(attr);
    if (val) {
      const newVal = val
        .split(',')
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);
          if (!parts[0]) return entry;
          try {
            parts[0] = new URL(parts[0], base).href;
          } catch {
            /* ignore */
          }
          return parts.join(' ');
        })
        .join(', ');
      el.setAttribute(attr, newVal);
    }
    return;
  }

  const val = el.getAttribute(attr);
  if (
    val &&
    !SKIP_URL_PREFIXES.some((p) => val.trim().toLowerCase().startsWith(p))
  ) {
    try {
      el.setAttribute(attr, new URL(val, base).href);
    } catch {
      /* ignore */
    }
  }
}
function resolveUrls(document: Document, baseUrlStr: string): void {
  let base: URL;
  try {
    base = new URL(baseUrlStr);
  } catch {
    return;
  }

  const elements = document.querySelectorAll('a[href],img[src],source[srcset]');
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') processUrlElement(el, 'href', base, false);
    else if (tag === 'img') processUrlElement(el, 'src', base, false);
    else if (tag === 'source') processUrlElement(el, 'srcset', base, true);
  }
}
function resolveDocumentBody(document: Document): Element {
  const { body } = document;
  if (body.innerHTML.trim().length > MIN_BODY_CONTENT_LENGTH) return body;
  const { children } = document.documentElement;
  for (const child of children) {
    if (
      child.tagName === 'BODY' &&
      child.innerHTML.trim().length > MIN_BODY_CONTENT_LENGTH
    ) {
      return child;
    }
  }

  return body;
}

export function serializeDocumentForMarkdown(
  document: Document,
  fallback: string
): string {
  const body = resolveDocumentBody(document);
  const bodyHtml = body.innerHTML;
  if (bodyHtml.trim().length > MIN_BODY_CONTENT_LENGTH) return bodyHtml;

  const outerHtml = document.documentElement.outerHTML;
  if (outerHtml.trim().length > MIN_BODY_CONTENT_LENGTH) return outerHtml;

  return fallback;
}
function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}
function mayContainNoise(html: string): boolean {
  const sample =
    html.length <= NOISE_SCAN_LIMIT
      ? html
      : `${html.substring(0, NOISE_SCAN_LIMIT)}\n${html.substring(html.length - NOISE_SCAN_LIMIT)}`;
  return NOISE_PATTERNS.some((re) => re.test(sample));
}
function surfaceHiddenTabPanels(document: Document): void {
  const panels = document.querySelectorAll(
    '[data-slot="tabContent"], [role="tabpanel"]'
  );
  for (const panel of panels) {
    const style = panel.getAttribute('style') ?? '';
    if (DISPLAY_NONE_REGEX.test(style)) {
      panel.setAttribute(
        'style',
        style.replace(DISPLAY_NONE_STRIP_REGEX, '').trim()
      );
    }
    panel.removeAttribute('hidden');
  }
}

function stripTabTriggers(document: Document): void {
  const tabs = document.querySelectorAll('[role="tab"]');
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i];
    if (!tab) continue;
    const isSelected =
      tab.getAttribute('aria-selected') === 'true' ||
      tab.getAttribute('data-state') === 'active' ||
      tab.hasAttribute('data-selected');
    if (!isSelected) {
      tab.remove();
    }
  }
}

/** Surface hidden tab panels, then strip unselected tab triggers. */
export function normalizeTabContent(document: Document): void {
  surfaceHiddenTabPanels(document);
  stripTabTriggers(document);
}

function normalizeTableCells(document: Document): void {
  const cells = document.querySelectorAll('td, th');
  for (const cell of cells) {
    const brs = cell.querySelectorAll('br');
    for (const br of brs) {
      br.replaceWith(' ');
    }

    const blocks = Array.from(
      cell.querySelectorAll('div, p, ul, li, h1, h2, h3, h4, h5, h6')
    );
    for (const block of blocks) {
      if (!block.parentNode) continue;
      const span = document.createElement('span');
      span.appendChild(document.createTextNode(' '));
      while (block.firstChild) {
        span.appendChild(block.firstChild);
      }
      span.appendChild(document.createTextNode(' '));
      for (const attr of Array.from(block.attributes)) {
        span.setAttribute(attr.name, attr.value);
      }
      block.replaceWith(span);
    }

    const walker = document.createTreeWalker(cell, NODE_FILTER_SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeValue) {
        node.nodeValue = node.nodeValue.replace(/\r?\n/g, ' ');
        if (node.nodeValue.includes('|')) {
          node.nodeValue = node.nodeValue.replace(/\|/g, '\\|');
        }
      }
    }
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasDirectPreDescendant(element: Element): boolean {
  return (
    element.tagName === 'PRE' ||
    Array.from(element.children).some(
      (child) => child.tagName === 'PRE' || child.querySelector('pre') !== null
    )
  );
}

function collectLeafTextSegments(element: Element): string[] {
  const seen = new Set<string>();
  const segments: string[] = [];
  const candidates = element.querySelectorAll('p,li,div,span');

  for (const candidate of candidates) {
    if (
      candidate.children.length > 0 ||
      candidate.querySelector('pre,code,table,ul,ol,blockquote,figure') !== null
    ) {
      continue;
    }

    const text = normalizeWhitespace(candidate.textContent || '');
    if (
      text.length === 0 ||
      text.length > REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS ||
      seen.has(text)
    ) {
      continue;
    }

    seen.add(text);
    segments.push(text);
  }

  if (segments.length > 0) return segments;

  const fallback = normalizeWhitespace(element.textContent || '');
  return fallback ? [fallback] : [];
}

function isHostnameLike(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

function hasPreviewMedia(element: Element): boolean {
  return element.querySelector('svg,canvas') !== null;
}

function isRedundantCodePreview(
  preview: Element,
  codeContainer: Element
): boolean {
  if (
    preview.tagName === 'FIGCAPTION' ||
    preview.querySelector(
      'a[href],button,input,select,textarea,form,video,audio,iframe,table,ul,ol,blockquote'
    ) !== null
  ) {
    return false;
  }

  const segments = collectLeafTextSegments(preview);
  if (
    segments.length === 0 ||
    segments.length > REDUNDANT_PREVIEW_MAX_SEGMENTS ||
    segments.some(
      (segment) => segment.length > REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS
    )
  ) {
    return false;
  }

  const codeText = normalizeWhitespace(codeContainer.textContent || '');
  if (!codeText) return false;

  const matchingSegments = segments.filter((segment) =>
    codeText.includes(segment)
  );
  if (matchingSegments.length === segments.length) return true;

  return (
    (hasPreviewMedia(preview) ||
      segments.some((segment) => isHostnameLike(segment))) &&
    matchingSegments.length > 0 &&
    segments.every(
      (segment) => segment.length <= REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS
    )
  );
}

function pruneFigurePreviewPanes(document: Document): void {
  for (const figure of document.querySelectorAll('figure')) {
    const directChildren = Array.from(figure.children);
    const codeChild = directChildren.find((child) =>
      hasDirectPreDescendant(child)
    );
    if (!codeChild) continue;

    for (const child of directChildren) {
      if (child === codeChild || child.tagName === 'FIGCAPTION') continue;
      if (isRedundantCodePreview(child, codeChild)) child.remove();
    }
  }
}

function isDemoInstructionBlock(element: Element): boolean {
  if (
    element.querySelector(
      'a[href],pre,code,table,ul,ol,blockquote,figure,h1,h2,h3,h4,h5,h6'
    ) !== null
  ) {
    return false;
  }

  const text = normalizeWhitespace(element.textContent || '');
  if (
    text.length === 0 ||
    text.length > INLINE_DEMO_INSTRUCTION_MAX_CHARS ||
    /[.!?]$/.test(text)
  ) {
    return false;
  }

  return collectLeafTextSegments(element).length <= 3;
}

function pruneDemoInstructionBlocks(document: Document): void {
  for (const container of document.querySelectorAll('div,section,article')) {
    const children = Array.from(container.children);
    const figureIndex = children.findIndex(
      (child) =>
        child.tagName === 'FIGURE' && child.querySelector('pre') !== null
    );
    if (figureIndex <= 0) continue;

    for (let i = 0; i < figureIndex; i++) {
      const child = children[i];
      if (child && isDemoInstructionBlock(child)) child.remove();
    }
  }
}

function normalizeHighlightedCodeLines(document: Document): void {
  for (const code of document.querySelectorAll('pre > code')) {
    const directChildren = Array.from(code.children);
    if (directChildren.length < 2) continue;

    const directSpans = directChildren.filter(
      (child) => child.tagName === 'SPAN'
    );
    if (directSpans.length !== directChildren.length) continue;

    const hasLineClass = directSpans.some((child) =>
      (child.getAttribute('class') ?? '').split(/\s+/).includes('line')
    );
    const hasNewlineNode = Array.from(code.childNodes).some(
      (node) => node.nodeType === 3 && /[\r\n]/.test(node.textContent ?? '')
    );

    if (hasNewlineNode || !hasLineClass) continue;

    for (let i = 0; i < directSpans.length - 1; i++) {
      const current = directSpans[i];
      const next = current?.nextSibling;
      if (next?.nodeType === 3 && (next.textContent ?? '').startsWith('\n')) {
        continue;
      }
      current?.after(document.createTextNode('\n'));
    }
  }
}

function cleanCodeExamples(document: Document): void {
  pruneFigurePreviewPanes(document);
  pruneDemoInstructionBlocks(document);
  normalizeHighlightedCodeLines(document);
}

function stripPromoLinks(document: Document): void {
  const links = document.querySelectorAll('a[href]');
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    if (!link) continue;
    const href = link.getAttribute('href');
    if (href && UTM_PARAM_REGEX.test(href)) {
      link.remove();
    }
  }
}

function separateAdjacentInlineElements(document: Document): void {
  const badges = document.querySelectorAll(
    'span.chakra-badge, [data-scope="badge"], [class*="badge"], [data-slot="label"], [slot="label"]'
  );
  for (const badge of badges) {
    const next = badge.nextSibling;
    if (next?.nodeType === 1) {
      badge.after(document.createTextNode(' '));
    }
  }
}

// Called on both raw documents (pre-article path) and article fragments
// (post-Readability). Some passes (stripTabTriggers, etc.) are no-ops
// on Readability output since tabs are already stripped or absent.
export function prepareDocumentForMarkdown(
  document: Document,
  baseUrl?: string,
  signal?: AbortSignal
): void {
  normalizeTabContent(document);
  cleanHeadings(document);
  stripNoise(document, signal);
  stripPromoLinks(document);
  cleanCodeExamples(document);
  separateAdjacentInlineElements(document);
  normalizeTableCells(document);
  normalizeTableStructure(document);

  if (baseUrl) resolveUrls(document, baseUrl);
}

// Some sites put tbody/thead/tfoot inside td/th, which breaks markdown tables.
function normalizeTableStructure(document: Document): void {
  for (const table of document.querySelectorAll('table')) {
    const theadCells = table.querySelectorAll('thead td');
    for (const td of theadCells) {
      const th = document.createElement('th');
      th.innerHTML = td.innerHTML;
      for (const attr of Array.from(td.attributes)) {
        th.setAttribute(attr.name, attr.value);
      }
      td.replaceWith(th);
    }
    for (const cell of table.querySelectorAll('th, td')) {
      for (const tag of ['tbody', 'thead', 'tfoot'] as const) {
        let nested = cell.querySelector(tag);
        while (nested) {
          table.appendChild(nested);
          nested = cell.querySelector(tag);
        }
      }
    }

    hoistNestedRows(table);
  }
}

export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string,
  signal?: AbortSignal
): string {
  const shouldParse =
    isFullDocumentHtml(html) ||
    mayContainNoise(html) ||
    HTML_FRAGMENT_MARKERS.test(html);
  if (!shouldParse) return html;

  try {
    const doc = document ?? parseHTML(html).document;
    prepareDocumentForMarkdown(doc, baseUrl, signal);
    return serializeDocumentForMarkdown(doc, html);
  } catch {
    return html;
  }
}
