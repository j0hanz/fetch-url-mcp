import { parseHTML } from 'linkedom';

import { config, logDebug } from './core.js';

const NOISE_SCAN_LIMIT = 50_000;
const MIN_BODY_CONTENT_LENGTH = 100;
const DIALOG_MIN_CHARS_FOR_PRESERVATION = 500;
const NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION = 500;
const ABORT_CHECK_INTERVAL = 500;
const NODE_FILTER_SHOW_TEXT = 4;
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
const SKIP_URL_PREFIXES = [
  '#',
  'javascript:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
];
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
];
const PROMO_TOKENS_AGGRESSIVE = ['ad', 'related', 'comment'];
const PROMO_TOKENS_BY_CATEGORY = {
  'cookie-banners': ['cookie', 'consent', 'popup', 'modal', 'overlay', 'toast'],
  newsletters: ['newsletter', 'subscribe'],
  'social-share': ['share', 'social'],
};

// Noise selector configurations
const BASE_NOISE_SELECTORS = {
  navFooter:
    'nav,footer,header[class*="site"],header[class*="nav"],header[class*="menu"],[role="banner"],[role="navigation"],[class*="breadcrumb"]',
  cookieBanners: '[role="dialog"]',
  hidden:
    '[style*="display: none"],[style*="display:none"],[style*="visibility: hidden"],[style*="visibility:hidden"],[hidden],[aria-hidden="true"]',
};
const NO_MATCH_REGEX = /a^/i;

// Noise removal types
type NoiseRemovalConfig = typeof config.noiseRemoval;
type NoiseWeights = NoiseRemovalConfig['weights'];
interface PromoTokenMatchers {
  readonly base: RegExp;
  readonly aggressive: RegExp;
}
interface NoiseContext {
  readonly flags: {
    readonly navFooter: boolean;
    readonly cookieBanners: boolean;
    readonly newsletters: boolean;
    readonly socialShare: boolean;
  };
  readonly structuralTags: Set<string>;
  readonly weights: NoiseWeights;
  readonly promoMatchers: PromoTokenMatchers;
  readonly promoEnabled: boolean;
  readonly extraSelectors: string[];
  readonly baseSelector: string;
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
function addTokens(target: Set<string>, tokens: readonly string[]): void {
  for (const token of tokens) target.add(token);
}
function getPromoMatchers(
  currentConfig: NoiseRemovalConfig,
  flags: NoiseContext['flags']
): PromoTokenMatchers {
  const baseTokens = new Set(PROMO_TOKENS_ALWAYS);
  const aggressiveTokens = new Set<string>();

  if (currentConfig.aggressiveMode) {
    addTokens(aggressiveTokens, PROMO_TOKENS_AGGRESSIVE);
  }

  if (flags.cookieBanners) {
    addTokens(baseTokens, PROMO_TOKENS_BY_CATEGORY['cookie-banners']);
  }
  if (flags.newsletters) {
    addTokens(baseTokens, PROMO_TOKENS_BY_CATEGORY['newsletters']);
  }
  if (flags.socialShare) {
    addTokens(baseTokens, PROMO_TOKENS_BY_CATEGORY['social-share']);
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
    weights: currentConfig.weights,
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
    newsletters: isEnabled('newsletters'),
    socialShare: isEnabled('social-share'),
  };

  const structuralTags = new Set(BASE_STRUCTURAL_TAGS);
  if (!currentConfig.preserveSvgCanvas) {
    structuralTags.add('svg');
    structuralTags.add('canvas');
  }

  const promoMatchers = getPromoMatchers(currentConfig, flags);
  const extraSelectors = currentConfig.extraSelectors
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Pre-build selectors
  const selectors = [BASE_NOISE_SELECTORS.hidden];
  if (flags.navFooter) selectors.push(BASE_NOISE_SELECTORS.navFooter);
  if (flags.cookieBanners) selectors.push(BASE_NOISE_SELECTORS.cookieBanners);
  const baseSelector = selectors.join(',');

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
    weights: currentConfig.weights,
    promoMatchers,
    promoEnabled: flags.cookieBanners || flags.newsletters || flags.socialShare,
    extraSelectors,
    baseSelector,
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
const ASIDE_NAV_LINK_DENSITY_THRESHOLD = 0.5;
const ASIDE_NAV_MIN_LINKS = 10;
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
const HIDDEN_STYLE_REGEX =
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

function calculateNavFooterScore(
  tagName: string,
  className: string,
  id: string,
  role: string | null,
  weights: NoiseWeights
): number {
  let score = 0;
  if (ALWAYS_NOISE_TAGS.has(tagName)) score += weights.structural;

  if (tagName === 'header') {
    if (
      (role && NAVIGATION_ROLES.has(role)) ||
      HEADER_NOISE_PATTERN.test(`${className} ${id}`)
    ) {
      score += weights.structural;
    }
  }

  if (tagName === 'aside') {
    score += weights.structural;
  }

  if (role && NAVIGATION_ROLES.has(role)) {
    if (tagName !== 'aside' || role !== 'complementary') {
      score += weights.structural;
    }
  }
  return score;
}

function calculatePromoScore(
  element: Element,
  className: string,
  id: string,
  context: NoiseContext
): number {
  if (!context.promoEnabled) return 0;

  const aggTest =
    context.promoMatchers.aggressive.test(className) ||
    context.promoMatchers.aggressive.test(id);
  const isAggressiveMatch = aggTest && !isWithinPrimaryContent(element);
  const isBaseMatch =
    !aggTest &&
    (context.promoMatchers.base.test(className) ||
      context.promoMatchers.base.test(id));

  return isAggressiveMatch || isBaseMatch ? context.weights.promo : 0;
}

function isNoiseElement(element: Element, context: NoiseContext): boolean {
  const tagName = element.tagName.toLowerCase();
  const className = element.getAttribute('class') ?? '';
  const id = element.getAttribute('id') ?? '';
  const role = element.getAttribute('role');
  const style = element.getAttribute('style');
  const elIsInteractive = isInteractive(element, role);
  const elIsHidden =
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    (style !== null && HIDDEN_STYLE_REGEX.test(style));

  let score = 0;
  const { weights } = context;

  // Structural
  if (context.structuralTags.has(tagName) && !elIsInteractive) {
    score += weights.structural;
  }

  // Nav/Footer Scoring
  if (context.flags.navFooter) {
    score += calculateNavFooterScore(tagName, className, id, role, weights);
  }

  // Hidden
  if (elIsHidden && !elIsInteractive) {
    score += weights.hidden;
  }

  // Sticky/Fixed
  if (FIXED_OR_HIGH_Z_PATTERN.test(className)) {
    score += weights.stickyFixed;
  }

  // Promo
  score += calculatePromoScore(element, className, id, context);

  return score >= weights.threshold;
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
      const href = a.getAttribute('href') ?? '';
      const txt = (a.textContent || '').replace(/[\u200B\s]/g, '');
      if (href.startsWith('#') && txt.length === 0) {
        a.remove();
      }
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
function stripNoise(
  document: Document,
  context: NoiseContext,
  signal?: AbortSignal
): void {
  cleanHeadings(document);

  // Structural Removal
  const { baseSelector, extraSelectors } = context;
  removeNodes(document.querySelectorAll(baseSelector));

  if (extraSelectors.length > 0) {
    removeNodes(document.querySelectorAll(extraSelectors.join(',')));
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
export function serializeDocumentForMarkdown(
  document: Document,
  fallback: string
): string {
  const bodyHtml = document.body.innerHTML;
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
    if (/display\s*:\s*none/i.test(style)) {
      panel.setAttribute(
        'style',
        style.replace(/display\s*:\s*none\s*;?/gi, '').trim()
      );
    }
    panel.removeAttribute('hidden');
  }
}

function stripTabTriggers(document: Document): void {
  surfaceHiddenTabPanels(document);
  const tabs = document.querySelectorAll('button[role="tab"]');
  for (let i = tabs.length - 1; i >= 0; i--) {
    tabs[i]?.remove();
  }
}

function escapeTableCellPipes(document: Document): void {
  const cells = document.querySelectorAll('td, th');
  for (const cell of cells) {
    const walker = document.createTreeWalker(cell, NODE_FILTER_SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.includes('|')) {
        node.textContent = node.textContent.replace(/\|/g, '\\|');
      }
    }
  }
}

function separateAdjacentInlineElements(document: Document): void {
  const badges = document.querySelectorAll(
    'span.chakra-badge, [data-scope="badge"], [class*="badge"]'
  );
  for (const badge of badges) {
    const next = badge.nextSibling;
    if (next?.nodeType === 1) {
      badge.after(document.createTextNode(' '));
    }
  }
}

export function prepareDocumentForMarkdown(
  document: Document,
  baseUrl?: string,
  signal?: AbortSignal
): void {
  const context = getContext();

  if (config.noiseRemoval.debug) {
    logDebug('Noise removal audit enabled', {
      categories: [...(context.flags.navFooter ? ['nav-footer'] : [])],
    });
  }

  stripNoise(document, context, signal);
  stripTabTriggers(document);
  separateAdjacentInlineElements(document);
  flattenTableCellBreaks(document);
  escapeTableCellPipes(document);
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
  }
}

function flattenTableCellBreaks(document: Document): void {
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

    const filterNewlines = (node: Node): void => {
      if (node.nodeType === 3 && node.nodeValue) {
        node.nodeValue = node.nodeValue.replace(/\r?\n/g, ' ');
      } else {
        for (const child of Array.from(node.childNodes)) {
          filterNewlines(child);
        }
      }
    };
    filterNewlines(cell);
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
