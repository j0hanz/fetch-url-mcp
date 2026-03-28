import { parseHTML } from 'linkedom';

import { config, logDebug } from '../lib/core.js';
import { Loggers } from '../lib/logger-names.js';
import { CharCode, isWhitespaceChar } from '../lib/utils.js';

import type { ExtractedArticle } from './types.js';

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
const DENSITY_BASE_CHARS = 100;
const MAX_PERMALINK_TEXT_LENGTH = 2;
const MIN_LINES_FOR_TRUNCATION_CHECK = 3;

// ── Regex patterns ──────────────────────────────────────────────────
const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
const HTML_FRAGMENT_MARKERS =
  /<\s*(?:article|main|section|div|nav|footer|header|aside|table|ul|ol)\b/i;
const NOISE_PATTERNS: readonly RegExp[] = [
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i,
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i,
  /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i,
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast)\b/i,
  /[\s"'](?:fixed|sticky|z-50|z-4|breadcrumbs?|pagination)\b/i,
];
const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_OR_HIGH_Z_PATTERN = /\b(?:fixed|sticky|z-(?:4\d|50))\b/;
const HEADING_PERMALINK_TEXT_PATTERN = /^(?:#|¶|§|¤|🔗)$/u;
const HEADING_PERMALINK_CLASS_PATTERN =
  /\b(?:mark|permalink|hash-link|anchor(?:js)?-?link|header-?link|heading-anchor|deep-link)\b/i;
const HIDDEN_STYLE_REGEX =
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const DISPLAY_NONE_REGEX = /display\s*:\s*none/i;
const DISPLAY_NONE_STRIP_REGEX = /display\s*:\s*none\s*;?/gi;
const UTM_PARAM_REGEX = /[?&]utm_(?:source|medium|campaign)=/i;
/** Sentinel regex that intentionally never matches; used for empty token sets. */
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
const DOCS_CONTROL_SELECTORS = [
  '.content-icon-container',
  '.edit-this-page',
  '.toc-overlay-icon',
  '.theme-toggle-container',
  '.sidebar-toggle',
  '.sidebar-drawer',
  '.toc-drawer',
  '.mobile-header',
  '.overlay.sidebar-overlay',
  '.overlay.toc-overlay',
  '.baseline-indicator',
  '.back-to-top',
  '.backtotop',
  '.headerlink',
  '[title="Edit this page"]',
  '.article-footer',
  '.baseline-indicator',
  'baseline-indicator',
  'mdn-content-feedback',
  'interactive-example',
] as const;

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
  const pattern = new RegExp(
    `(?:^|[^a-z0-9])(?:${[...tokens].map(escapeRegexLiteral).join('|')})(?:$|[^a-z0-9])`,
    'i'
  );
  return pattern;
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
function buildNoiseSelector(flags: NoiseContext['flags']): string {
  const selectors = [BASE_NOISE_SELECTORS.hidden];
  if (flags.navFooter) selectors.push(BASE_NOISE_SELECTORS.navFooter);
  if (flags.cookieBanners) selectors.push(BASE_NOISE_SELECTORS.cookieBanners);
  return selectors.join(',');
}

function buildCandidateSelector(structuralTags: Set<string>): string {
  return [
    ...structuralTags,
    ...ALWAYS_NOISE_TAGS,
    'aside',
    'header',
    '[class]',
    '[id]',
    '[role]',
    '[style]',
  ].join(',');
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

  const noiseSelector = buildNoiseSelector(flags);
  const extraSelector =
    extraSelectors.length > 0 ? extraSelectors.join(',') : null;
  const candidateSelector = buildCandidateSelector(structuralTags);

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
function isPrimaryContent(element: Element, checkDescendants = false): boolean {
  if (element.closest('article,main,[role="main"]')) return true;
  if (checkDescendants && element.querySelector('article,main,[role="main"]'))
    return true;
  return false;
}
function isLinkDenseNavigation(
  element: Element,
  checkContainedNav = false
): boolean {
  if (checkContainedNav && element.querySelector('nav')) return true;
  const links = element.querySelectorAll('a[href]');
  if (links.length < ASIDE_NAV_MIN_LINKS) return false;
  const textLen = (element.textContent || '').trim().length;
  if (textLen === 0) return true;
  return (
    links.length / (textLen / DENSITY_BASE_CHARS) >=
    ASIDE_NAV_LINK_DENSITY_THRESHOLD
  );
}
function shouldPreserve(element: Element, tagName: string): boolean {
  // Check Dialog
  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') {
    if (isPrimaryContent(element)) return true;
    const textLen = (element.textContent || '').length;
    if (textLen > DIALOG_MIN_CHARS_FOR_PRESERVATION) return true;
    return element.querySelector('h1,h2,h3,h4,h5,h6') !== null;
  }

  if (tagName === 'nav' || tagName === 'footer') {
    if (element.querySelector('article,main,section,[role="main"]'))
      return true;
    const textLen = (element.textContent || '').trim().length;
    if (textLen < NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION) return false;
    if (isLinkDenseNavigation(element)) return false;
    return true;
  }

  // Check Aside — preserve only if it looks like article content, not navigation
  if (tagName === 'aside') {
    if (!isPrimaryContent(element)) return false;
    return !isLinkDenseNavigation(element, true);
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

function isStructuralNoise(
  tagName: string,
  interactive: boolean,
  context: NoiseContext
): boolean {
  return context.structuralTags.has(tagName) && !interactive;
}

function isNavigationNoise(
  tagName: string,
  role: string | null,
  className: string,
  id: string,
  context: NoiseContext
): boolean {
  if (!context.flags.navFooter) return false;
  if (ALWAYS_NOISE_TAGS.has(tagName)) return true;
  if (
    tagName === 'header' &&
    ((role !== null && NAVIGATION_ROLES.has(role)) ||
      HEADER_NOISE_PATTERN.test(`${className} ${id}`))
  )
    return true;
  if (tagName === 'aside') return true;
  return (
    role !== null &&
    NAVIGATION_ROLES.has(role) &&
    (tagName !== 'aside' || role !== 'complementary')
  );
}

function isHiddenNoise(hidden: boolean, interactive: boolean): boolean {
  return hidden && !interactive;
}

function isPositionalNoise(className: string, element: Element): boolean {
  return (
    FIXED_OR_HIGH_Z_PATTERN.test(className) &&
    (element.textContent || '').trim().length <
      NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION
  );
}

function isPromoNoise(
  className: string,
  id: string,
  element: Element,
  context: NoiseContext
): boolean {
  if (!context.promoEnabled) return false;
  const aggTest =
    context.promoMatchers.aggressive.test(className) ||
    context.promoMatchers.aggressive.test(id);
  if (aggTest && !isPrimaryContent(element)) return true;
  if (
    context.promoMatchers.base.test(className) ||
    context.promoMatchers.base.test(id)
  ) {
    if (!isPrimaryContent(element, true)) return true;
  }
  return false;
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

  return (
    isStructuralNoise(tagName, interactive, context) ||
    isNavigationNoise(tagName, role, className, id, context) ||
    isHiddenNoise(hidden, interactive) ||
    isPositionalNoise(className, element) ||
    isPromoNoise(className, id, element, context)
  );
}
function stripHeadingWrapperDivs(h: Element): void {
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
}

function stripPermalinkAnchors(h: Element): void {
  const anchors = h.querySelectorAll('a');
  for (let j = anchors.length - 1; j >= 0; j--) {
    const a = anchors[j];
    if (!a?.parentNode) continue;
    if (isHeadingPermalinkAnchor(a)) a.remove();
  }
}

function stripZeroWidthSpaces(h: Element, document: Document): void {
  const walker = document.createTreeWalker(h, NODE_FILTER_SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes('\u200B')) {
      node.textContent = node.textContent.replace(/\u200B/g, '');
    }
  }
}

function cleanHeadings(document: Document): void {
  const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of headings) {
    if (!h.parentNode) continue;
    stripHeadingWrapperDivs(h);
    stripPermalinkAnchors(h);
    stripZeroWidthSpaces(h, document);
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
  if (
    HEADING_PERMALINK_CLASS_PATTERN.test(className) &&
    text.length <= MAX_PERMALINK_TEXT_LENGTH
  ) {
    return true;
  }

  const ariaHidden = anchor.getAttribute('aria-hidden');
  const tabindex = anchor.getAttribute('tabindex');
  return (
    (ariaHidden === 'true' || tabindex === '-1') &&
    text.length <= MAX_PERMALINK_TEXT_LENGTH
  );
}

function hoistNestedRows(table: Element): void {
  const nestedRows = table.querySelectorAll('td tr, th tr');
  // Iterate backwards to preserve the original document order when inserting after the parent row
  for (let i = nestedRows.length - 1; i >= 0; i--) {
    const nestedRow = nestedRows[i];
    if (nestedRow?.closest('table') !== table) continue;

    const parentRow = nestedRow.parentElement?.closest('tr');
    if (parentRow && parentRow !== nestedRow) {
      parentRow.after(nestedRow);
    }
  }
}
function stripNoise(document: Document, signal?: AbortSignal): void {
  const context = getContext();

  if (config.noiseRemoval.debug) {
    logDebug(
      'Noise removal audit enabled',
      {
        categories: [...(context.flags.navFooter ? ['nav-footer'] : [])],
      },
      Loggers.LOG_TRANSFORM
    );
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
      throw Error('Noise removal aborted');
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
function parseSrcsetEntries(
  srcset: string
): { url: string; descriptor: string }[] {
  return srcset.split(',').map((entry) => {
    const parts = entry.trim().split(/\s+/);
    return { url: parts[0] ?? '', descriptor: parts.slice(1).join(' ') };
  });
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
      const newVal = parseSrcsetEntries(val)
        .map((entry) => {
          if (!entry.url) return entry.descriptor;
          const resolved = URL.parse(entry.url, base)?.href ?? entry.url;
          return entry.descriptor
            ? `${resolved} ${entry.descriptor}`
            : resolved;
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
    const resolved = URL.parse(val, base);
    if (resolved) el.setAttribute(attr, resolved.href);
  }
}

// Rewrite WordPress Photon CDN image URLs to point to the original host, since srcset URLs are often preserved with the updated domain while src is not.
// This ensures images are correctly resolved when the page is migrated to a new domain but still references the old domain in img src attributes.
export const WP_PHOTON_HOST_PATTERN = /^i\d\.wp\.com$/;

function rewritePhotonSrc(document: Document, pageHost: string): void {
  for (const img of document.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const parsed = URL.parse(src);
    if (!parsed || !WP_PHOTON_HOST_PATTERN.test(parsed.hostname)) continue;
    if (img.getAttribute('srcset')) continue;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const originHost = segments[0];
    if (!originHost?.includes('.')) continue;
    const resourcePath = `/${segments.slice(1).join('/')}`;
    const rewritten = `https://${pageHost}${resourcePath}`;
    img.setAttribute('src', rewritten);
  }
}

// For images with src URLs pointing to a different domain than the page, check if their srcset contains a same-domain URL and prefer that for the src attribute.
// This can help preserve image loading when migrating content that references an old domain, as srcset entries are often left unchanged while src attributes are updated or removed.
function preferSameDomainSrc(document: Document, base: URL): void {
  const pageHost = base.hostname;
  for (const img of document.querySelectorAll('img[src][srcset]')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const srcParsed = URL.parse(src);
    if (!srcParsed || srcParsed.hostname === pageHost) continue;

    const srcset = img.getAttribute('srcset') ?? '';
    for (const entry of parseSrcsetEntries(srcset)) {
      if (!entry.url) continue;
      const parsed = URL.parse(entry.url);
      if (parsed?.hostname === pageHost) {
        img.setAttribute('src', entry.url);
        break;
      }
    }
  }
}

export function extractNoscriptImages(document: Document): void {
  for (const noscript of document.querySelectorAll('noscript')) {
    // linkedom may parse noscript children as DOM or raw text — handle both.
    let imgs = Array.from(noscript.querySelectorAll('img'));
    if (imgs.length === 0) {
      const html = noscript.innerHTML || noscript.textContent || '';
      if (!/<img\b/i.test(html)) continue;
      const { document: fragDoc } = parseHTML(`<body>${html}</body>`);
      imgs = Array.from(fragDoc.querySelectorAll('img'));
    }
    if (imgs.length === 0) continue;

    // Skip when the previous sibling is (or contains) an <img> — the
    // lazy-loaded placeholder is already in the DOM and the translators
    // handle data-src / placeholder detection.
    const prev = noscript.previousElementSibling;
    if (prev?.tagName === 'IMG' || prev?.querySelector('img')) continue;

    for (const img of imgs) {
      // Skip tracking pixels (commonly 1×1 images placed in noscript by
      // analytics providers).
      if (
        img.getAttribute('width') === '1' ||
        img.getAttribute('height') === '1'
      )
        continue;
      noscript.before(img.cloneNode(true));
    }
  }
}

function resolveUrls(document: Document, baseUrlStr: string): void {
  const base = URL.parse(baseUrlStr);
  if (!base) return;

  rewritePhotonSrc(document, base.hostname);
  preferSameDomainSrc(document, base);

  const elements = document.querySelectorAll('a[href],img[src],source[srcset]');
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') processUrlElement(el, 'href', base, false);
    else if (tag === 'img') processUrlElement(el, 'src', base, false);
    else if (tag === 'source') processUrlElement(el, 'srcset', base, true);
  }
}
function getValidContentHtml(element: Element | null): string | null {
  if (!element) return null;
  const html = element.innerHTML.trim();
  return html.length > MIN_BODY_CONTENT_LENGTH ? html : null;
}

export function resolveDocumentBody(document: Document): Element {
  const { body } = document;
  if (getValidContentHtml(body)) return body;

  const { children } = document.documentElement;
  for (const child of children) {
    if (child.tagName === 'BODY' && getValidContentHtml(child)) {
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
  const bodyHtml = getValidContentHtml(body);
  if (bodyHtml) return bodyHtml;

  const outerHtml = document.documentElement.outerHTML.trim();
  if (outerHtml.length > MIN_BODY_CONTENT_LENGTH) return outerHtml;

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

function convertBlockToSpan(block: Element, document: Document): void {
  if (!block.parentNode) return;
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

function normalizeTableCellTextNodes(cell: Element, document: Document): void {
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
      convertBlockToSpan(block, document);
    }

    normalizeTableCellTextNodes(cell, document);
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

function hasInteractiveOrComplexContent(preview: Element): boolean {
  if (preview.tagName === 'FIGCAPTION') return true;
  return (
    preview.querySelector(
      'a[href],button,input,select,textarea,form,video,audio,iframe,table,ul,ol,blockquote'
    ) !== null
  );
}

function hasValidTextSegments(segments: string[]): boolean {
  return (
    segments.length > 0 &&
    segments.length <= REDUNDANT_PREVIEW_MAX_SEGMENTS &&
    segments.every(
      (segment) => segment.length <= REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS
    )
  );
}

function isRedundantCodePreview(
  preview: Element,
  codeContainer: Element
): boolean {
  if (hasInteractiveOrComplexContent(preview)) return false;

  const segments = collectLeafTextSegments(preview);
  if (!hasValidTextSegments(segments)) return false;

  const codeText = normalizeWhitespace(codeContainer.textContent || '');
  if (!codeText) return false;

  const matchingSegments = segments.filter((segment) =>
    codeText.includes(segment)
  );
  if (matchingSegments.length === segments.length) return true;

  return (
    (hasPreviewMedia(preview) || segments.some(isHostnameLike)) &&
    matchingSegments.length > 0
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

const COPY_BUTTON_SELECTOR =
  'button,a[href="#copy"],a[href="#"],span[class*="copy"]';
const COPY_BUTTON_TEXT_PATTERN = /^copy(?: code)?$/i;

function stripCodeBlockCopyButtons(document: Document): void {
  for (const pre of document.querySelectorAll('pre')) {
    const candidates = pre.querySelectorAll(COPY_BUTTON_SELECTOR);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!el) continue;
      const text = (el.textContent || '').trim();
      if (
        el.tagName === 'BUTTON' ||
        COPY_BUTTON_TEXT_PATTERN.test(text) ||
        (el.getAttribute('href') ?? '').includes('#copy')
      ) {
        el.remove();
      }
    }
  }
}

function cleanCodeExamples(document: Document): void {
  stripCodeBlockCopyButtons(document);
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

const CODE_EDITOR_LANG_REGEX = /\blanguage-(\S+)/;

// Some documentation sites render code examples as highlighted, aria-hidden blocks with a textarea containing the raw code for accessibility.
// Surface the textarea content and remove the redundant highlighted block to produce cleaner markdown output.
export function surfaceCodeEditorContent(document: Document): void {
  for (const pre of document.querySelectorAll('pre[aria-hidden="true"]')) {
    const codeChild = pre.querySelector('code');
    if (!codeChild) continue;

    const container = pre.parentElement;
    if (!container) continue;

    const textarea = container.querySelector('textarea');
    if (!textarea) continue;

    // Extract language from the highlighted code element
    const langMatch = CODE_EDITOR_LANG_REGEX.exec(
      codeChild.getAttribute('class') ?? ''
    );
    const lang = langMatch?.[1] ?? '';

    // Build a clean pre>code block from the textarea plain text
    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    if (lang) newCode.setAttribute('class', `language-${lang}`);
    newCode.textContent = textarea.textContent || '';
    newPre.appendChild(newCode);
    container.insertBefore(newPre, pre);
    pre.remove();
    textarea.remove();
  }
}

export function stripDocsControls(document: Document): void {
  removeNodes(document.querySelectorAll(DOCS_CONTROL_SELECTORS.join(',')));
}

export function stripScreenReaderText(document: Document): void {
  const selectors = [
    '.sr-only',
    '.screen-reader-text',
    '.visually-hidden',
    '[class*="sr-only"]',
    '[class*="visually-hidden"]',
    '.cdk-visually-hidden',
    '.vh',
    '.hidden-visually',
  ];
  removeNodes(document.querySelectorAll(selectors.join(',')));
}

function stripAriaLiveInstructions(document: Document): void {
  for (const el of document.querySelectorAll('[aria-live]')) {
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length <= INLINE_DEMO_INSTRUCTION_MAX_CHARS) {
      el.remove();
    }
  }
}

export function runDocsControlPass(document: Document): void {
  normalizeTabContent(document);
  surfaceCodeEditorContent(document);
  cleanHeadings(document);
  stripDocsControls(document);
  stripAriaLiveInstructions(document);
  stripPromoLinks(document);
  separateAdjacentInlineElements(document);
}

const PHRASING_PARENTS = new Set([
  'P',
  'LI',
  'TD',
  'TH',
  'DD',
  'SPAN',
  'LABEL',
  'FIGCAPTION',
  'BLOCKQUOTE',
]);

function unwrapInlineButtons(document: Document): void {
  for (const btn of document.querySelectorAll('button')) {
    const parent = btn.parentElement;
    if (!parent || !PHRASING_PARENTS.has(parent.tagName)) continue;
    btn.replaceWith(...Array.from(btn.childNodes));
  }
}

function runStructuralNoisePass(
  document: Document,
  signal?: AbortSignal
): void {
  unwrapInlineButtons(document);
  stripNoise(document, signal);
}

function runCodeExamplePass(document: Document): void {
  cleanCodeExamples(document);
}

function unwrapOrphanedTableCells(document: Document): void {
  for (const cell of document.querySelectorAll('td, th')) {
    if (!cell.closest('table')) {
      cell.replaceWith(...Array.from(cell.childNodes));
    }
  }
}

function runTableNormalizationPass(document: Document): void {
  unwrapOrphanedTableCells(document);
  normalizeTableCells(document);
  normalizeTableStructure(document);
}

function runUrlResolutionPass(document: Document, baseUrl?: string): void {
  if (baseUrl) resolveUrls(document, baseUrl);
}

// Called on both raw documents (pre-article path) and article fragments
// (post-Readability). Some passes (stripTabTriggers, etc.) are no-ops
// on Readability output since tabs are already stripped or absent.
export function prepareDocumentForMarkdown(
  document: Document,
  baseUrl?: string,
  signal?: AbortSignal
): void {
  extractNoscriptImages(document);
  runDocsControlPass(document);
  runStructuralNoisePass(document, signal);
  runCodeExamplePass(document);
  runTableNormalizationPass(document);
  runUrlResolutionPass(document, baseUrl);
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

// ── Content evaluation heuristics ───────────────────────────────────

const MIN_CONTENT_RATIO = 0.15;
const MIN_HTML_LENGTH_FOR_GATE = 100;

interface RetentionRule {
  selector: string;
  pattern: RegExp;
  minThreshold: number;
  ratio: number;
}

const RETENTION_RULES: readonly RetentionRule[] = [
  {
    selector: 'h1,h2,h3,h4,h5,h6',
    pattern: /<h[1-6]\b/gi,
    minThreshold: 1,
    ratio: 0.3,
  },
  { selector: 'pre', pattern: /<pre\b/gi, minThreshold: 1, ratio: 0.15 },
  { selector: 'table', pattern: /<table\b/gi, minThreshold: 1, ratio: 0.5 },
  { selector: 'img', pattern: /<img\b/gi, minThreshold: 4, ratio: 0.2 },
];

const MIN_HEADINGS_FOR_EMPTY_SECTION_GATE = 5;
const MAX_EMPTY_SECTION_RATIO = 0.15;

const MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK = 20;
const MAX_TRUNCATED_LINE_RATIO = 0.95;

function resolveHtmlDocument(htmlOrDocument: string | Document): Document {
  if (typeof htmlOrDocument !== 'string') return htmlOrDocument;

  const needsWrapper = !/^\s*<(?:!doctype|html|body)\b/i.test(htmlOrDocument);
  const htmlToParse = needsWrapper
    ? `<!DOCTYPE html><html><body>${htmlOrDocument}</body></html>`
    : htmlOrDocument;

  try {
    return parseHTML(htmlToParse).document;
  } catch {
    // Don't crash on parse failures.
    return parseHTML('<!DOCTYPE html><html><body></body></html>').document;
  }
}

function getTextContentSkippingHidden(node: Node, parts: string[]): void {
  const { nodeType } = node;
  if (nodeType === 3) {
    const { textContent } = node;
    if (textContent) parts.push(textContent);
    return;
  }
  if (nodeType !== 1) return;

  const element = node as Element;
  if (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true'
  ) {
    return;
  }

  const { tagName } = element;
  if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT')
    return;

  for (const child of node.childNodes) {
    getTextContentSkippingHidden(child, parts);
  }
}

export function getVisibleTextLength(
  htmlOrDocument: string | Document
): number {
  if (typeof htmlOrDocument === 'string') {
    const doc = resolveHtmlDocument(htmlOrDocument);
    const body = resolveDocumentBody(doc);
    for (const el of body.querySelectorAll('script,style,noscript')) {
      el.remove();
    }
    return (body.textContent || '').replace(/\s+/g, ' ').trim().length;
  }
  const body = resolveDocumentBody(htmlOrDocument);
  const parts: string[] = [];
  getTextContentSkippingHidden(body, parts);
  return parts.join('').replace(/\s+/g, ' ').trim().length;
}

function countMatchingElements(root: ParentNode, selector: string): number {
  return root.querySelectorAll(selector).length;
}

function getHeadingLevel(heading: Element): number | null {
  const match = /^H([1-6])$/.exec(heading.tagName);
  if (!match) return null;

  return Number.parseInt(match[1] ?? '', 10);
}

function hasSectionContent(heading: Element): boolean {
  const level = getHeadingLevel(heading);
  if (level === null) return false;

  let current = heading.nextElementSibling;
  while (current) {
    const currentLevel = getHeadingLevel(current);
    if (currentLevel !== null && currentLevel <= level) return false;

    const text = current.textContent.trim();
    if (text.length > 0) return true;
    if (current.querySelector('img,table,pre,code,ul,ol,figure,blockquote')) {
      return true;
    }

    current = current.nextElementSibling;
  }

  return false;
}

function countEmptyHeadingSections(root: ParentNode): number {
  let emptyCount = 0;
  const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');

  for (const heading of headings) {
    // Skip headings that are explicitly hidden or for screen readers
    const cls = heading.getAttribute('class') ?? '';
    if (
      cls.includes('screen-reader-text') ||
      cls.includes('sr-only') ||
      cls.includes('visually-hidden')
    ) {
      continue;
    }
    if (!hasSectionContent(heading)) emptyCount += 1;
  }

  return emptyCount;
}

// Heuristic to detect if the content was truncated due to length limits by checking for incomplete sentences.
const SENTENCE_ENDING_CODES = new Set<number>([
  CharCode.PERIOD,
  CharCode.EXCLAMATION,
  CharCode.QUESTION,
  CharCode.COLON,
  CharCode.SEMICOLON,
  CharCode.DOUBLE_QUOTE,
  CharCode.SINGLE_QUOTE,
  CharCode.RIGHT_PAREN,
  CharCode.RIGHT_BRACKET,
  CharCode.BACKTICK,
]);

function trimLineOffsets(
  text: string,
  lineStart: number,
  lineEnd: number
): { start: number; end: number } | null {
  let start = lineStart;
  while (start < lineEnd && isWhitespaceChar(text.charCodeAt(start))) start++;
  let end = lineEnd - 1;
  while (end >= start && isWhitespaceChar(text.charCodeAt(end))) end--;
  if (end < start) return null;
  const trimmedLen = end - start + 1;
  return trimmedLen > MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK
    ? { start, end }
    : null;
}

function classifyLine(
  text: string,
  lineStart: number,
  lineEnd: number
): { counted: boolean; incomplete: boolean } {
  const lineLength = lineEnd - lineStart;
  if (lineLength <= MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK)
    return { counted: false, incomplete: false };

  const trimmed = trimLineOffsets(text, lineStart, lineEnd);
  if (!trimmed) return { counted: false, incomplete: false };

  const lastChar = text.charCodeAt(trimmed.end);
  return { counted: true, incomplete: !SENTENCE_ENDING_CODES.has(lastChar) };
}

function hasTruncatedSentences(text: string): boolean {
  let lineStart = 0;
  let linesFound = 0;
  let incompleteFound = 0;
  const len = text.length;

  for (let i = 0; i <= len; i++) {
    const isEnd = i === len;
    const isNewline = !isEnd && text.charCodeAt(i) === CharCode.LF;

    if (isNewline || isEnd) {
      const { counted, incomplete } = classifyLine(text, lineStart, i);
      if (counted) {
        linesFound++;
        if (incomplete) incompleteFound++;
      }
      lineStart = i + 1;
    }
  }

  if (linesFound < MIN_LINES_FOR_TRUNCATION_CHECK) return false;
  return incompleteFound / linesFound > MAX_TRUNCATED_LINE_RATIO;
}

function passesContentRatioGate(
  articleTextLength: number,
  document: Document
): boolean {
  const originalLength = getVisibleTextLength(document);
  return (
    originalLength < MIN_HTML_LENGTH_FOR_GATE ||
    articleTextLength / originalLength >= MIN_CONTENT_RATIO
  );
}

const DATA_IMG_PATTERN = /<img\b[^>]*\bsrc\s*=\s*["']?data:/gi;

function countRealImages(htmlOrDoc: string | Document): number {
  if (typeof htmlOrDoc === 'string') {
    const total = htmlOrDoc.match(/<img\b/gi)?.length ?? 0;
    const dataImages = htmlOrDoc.match(DATA_IMG_PATTERN)?.length ?? 0;
    return total - dataImages;
  }
  let count = 0;
  for (const img of htmlOrDoc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('data:')) count++;
  }
  return count;
}

function passesRetentionRulesFromHtml(
  originalDoc: Document,
  articleHtml: string
): boolean {
  return RETENTION_RULES.every(({ selector, pattern, minThreshold, ratio }) => {
    // Exclude lazy-loaded placeholder images (data: URI src) from the
    // original count so they don't inflate the denominator and cause
    // false retention failures.
    const original =
      selector === 'img'
        ? countRealImages(originalDoc)
        : countMatchingElements(originalDoc, selector);
    if (original < minThreshold) return true;
    // For images, also exclude data: URIs from the article count to
    // align with the denominator's real-image filtering.
    const articleCount =
      selector === 'img'
        ? countRealImages(articleHtml)
        : (articleHtml.match(pattern)?.length ?? 0);
    return articleCount / original >= ratio;
  });
}

function passesEmptySectionRatio(articleDoc: Document): boolean {
  const headings = Array.from(
    articleDoc.querySelectorAll('h1,h2,h3,h4,h5,h6')
  ).filter((h) => {
    const cls = h.getAttribute('class') ?? '';
    return (
      !cls.includes('screen-reader-text') &&
      !cls.includes('sr-only') &&
      !cls.includes('visually-hidden')
    );
  });
  const headingCount = headings.length;
  return (
    headingCount < MIN_HEADINGS_FOR_EMPTY_SECTION_GATE ||
    countEmptyHeadingSections(articleDoc) / headingCount <=
      MAX_EMPTY_SECTION_RATIO
  );
}

export function evaluateArticleContent(
  article: ExtractedArticle,
  document: Document
): Document | null {
  if (!passesContentRatioGate(article.textContent.length, document)) {
    logDebug('FAILED passesContentRatioGate', undefined, Loggers.LOG_TRANSFORM);
    return null;
  }

  if (!passesRetentionRulesFromHtml(document, article.content)) {
    logDebug(
      'FAILED passesRetentionRulesFromHtml',
      undefined,
      Loggers.LOG_TRANSFORM
    );
    return null;
  }

  if (hasTruncatedSentences(article.textContent)) {
    logDebug('FAILED hasTruncatedSentences', undefined, Loggers.LOG_TRANSFORM);
    return null;
  }

  const articleDoc = parseHTML(
    `<!DOCTYPE html><html><body>${article.content}</body></html>`
  ).document;

  if (!passesEmptySectionRatio(articleDoc)) {
    const headings = articleDoc.querySelectorAll('h1,h2,h3,h4,h5,h6');
    logDebug(
      `FAILED passesEmptySectionRatio: ${headings.length} headings`,
      undefined,
      Loggers.LOG_TRANSFORM
    );
    for (const h of headings) {
      logDebug(
        `H: ${h.textContent} ${String(hasSectionContent(h))}`,
        undefined,
        Loggers.LOG_TRANSFORM
      );
    }
    return null;
  }

  return articleDoc;
}
