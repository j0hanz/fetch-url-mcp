import { parseHTML } from 'linkedom';

import { config } from './config.js';
import { logDebug } from './observability.js';

// --- Constants & Pre-compiled Regex ---

const NOISE_SCAN_LIMIT = 50_000;
const MIN_BODY_CONTENT_LENGTH = 100;
const DIALOG_MIN_CHARS_FOR_PRESERVATION = 500;
const NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION = 500;

// Merged markers for fast rejection
const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;

// Split into smaller regexes to stay within sonarjs/regex-complexity limit
const NOISE_PATTERNS: readonly RegExp[] = [
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i,
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i,
  /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i,
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast)\b/i,
  /[\s"'](?:fixed|sticky|z-50|z-4|isolate|breadcrumb|pagination)\b/i,
];

const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_OR_HIGH_Z_PATTERN = /\b(?:fixed|sticky|z-(?:4\d|50)|isolate)\b/;

const SKIP_URL_PREFIXES = [
  '#',
  'java' + 'script:',
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
  'pagination',
  'pager',
  'taglist',
];
const PROMO_TOKENS_AGGRESSIVE = ['ad', 'related', 'comment'];
const PROMO_TOKENS_BY_CATEGORY = {
  'cookie-banners': ['cookie', 'consent', 'popup', 'modal', 'overlay', 'toast'],
  newsletters: ['newsletter', 'subscribe'],
  'social-share': ['share', 'social'],
};

const BASE_NOISE_SELECTORS = {
  navFooter:
    'nav,footer,header[class*="site"],header[class*="nav"],header[class*="menu"],[role="banner"],[role="navigation"]',
  cookieBanners: '[role="dialog"]',
  hidden:
    '[style*="display: none"],[style*="display:none"],[hidden],[aria-hidden="true"]',
};

const NO_MATCH_REGEX = /a^/i;

// --- Types ---

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

// --- State Cache ---

let cachedContext: NoiseContext | undefined;
let lastConfigRef: NoiseRemovalConfig | undefined;

// --- Helpers Inlined/Optimized ---

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
  flags: NoiseContext['flags']
): PromoTokenMatchers {
  const baseTokens = new Set(PROMO_TOKENS_ALWAYS);
  const aggressiveTokens = new Set<string>();

  if (currentConfig.aggressiveMode) {
    for (const t of PROMO_TOKENS_AGGRESSIVE) aggressiveTokens.add(t);
  }

  if (flags.cookieBanners)
    for (const t of PROMO_TOKENS_BY_CATEGORY['cookie-banners'])
      baseTokens.add(t);
  if (flags.newsletters)
    for (const t of PROMO_TOKENS_BY_CATEGORY['newsletters']) baseTokens.add(t);
  if (flags.socialShare)
    for (const t of PROMO_TOKENS_BY_CATEGORY['social-share']) baseTokens.add(t);

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
  if (cachedContext && lastConfigRef === currentConfig) {
    return cachedContext;
  }

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
  lastConfigRef = currentConfig;
  return cachedContext;
}

// --- Hot Path Logic ---

function isInteractive(element: Element, role: string | null): boolean {
  if (role && INTERACTIVE_CONTENT_ROLES.has(role)) return true;
  const ds = element.getAttribute('data-state');
  if (ds === 'inactive' || ds === 'closed') return true;
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

function scoreNavFooter(
  tagName: string,
  role: string | null,
  className: string,
  id: string,
  weights: NoiseWeights
): number {
  let score = 0;
  if (ALWAYS_NOISE_TAGS.has(tagName)) score += weights.structural;

  // Header Boilerplate
  if (tagName === 'header') {
    if (
      (role && NAVIGATION_ROLES.has(role)) ||
      HEADER_NOISE_PATTERN.test(`${className} ${id}`)
    ) {
      score += weights.structural;
    }
  }

  // Role Noise
  if (role && NAVIGATION_ROLES.has(role)) {
    if (tagName !== 'aside' || role !== 'complementary') {
      score += weights.structural;
    }
  }
  return score;
}

function isNoiseElement(element: Element, context: NoiseContext): boolean {
  const tagName = element.tagName.toLowerCase();
  const className = element.getAttribute('class') ?? '';
  const id = element.getAttribute('id') ?? '';
  const role = element.getAttribute('role');

  const _isInteractive = isInteractive(element, role);

  const style = element.getAttribute('style');
  const isHidden =
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    (style !== null &&
      /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(style));

  let score = 0;
  const { weights } = context;

  // Structural
  if (context.structuralTags.has(tagName) && !_isInteractive) {
    score += weights.structural;
  }

  // Nav/Footer Scoring
  if (context.flags.navFooter) {
    score += scoreNavFooter(tagName, role, className, id, weights);
  }

  // Hidden
  if (isHidden && !_isInteractive) {
    score += weights.hidden;
  }

  // Sticky/Fixed
  if (FIXED_OR_HIGH_Z_PATTERN.test(className)) {
    score += weights.stickyFixed;
  }

  // Promo
  if (context.promoEnabled) {
    const aggTest =
      context.promoMatchers.aggressive.test(className) ||
      context.promoMatchers.aggressive.test(id);
    const isAggressiveMatch = aggTest && !isWithinPrimaryContent(element);
    const isBaseMatch =
      !aggTest &&
      (context.promoMatchers.base.test(className) ||
        context.promoMatchers.base.test(id));

    if (isAggressiveMatch || isBaseMatch) {
      score += weights.promo;
    }
  }

  return score >= weights.threshold;
}

function cleanHeadingWrapperDivs(h: Element): void {
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

function cleanHeadingAnchors(h: Element): void {
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
}

function cleanHeadingZeroWidth(h: Element, document: Document): void {
  const walker = document.createTreeWalker(h, 4); // SHOW_TEXT
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes('\u200B')) {
      node.textContent = node.textContent.replace(/\u200B/g, '');
    }
  }
}

function cleanHeadings(document: Document): void {
  // Clean Heading Anchors
  const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of headings) {
    if (!h.parentNode) continue;
    cleanHeadingWrapperDivs(h);
    cleanHeadingAnchors(h);
    cleanHeadingZeroWidth(h, document);
  }
}

function stripNoise(document: Document, context: NoiseContext): void {
  cleanHeadings(document);

  // Remove Base & Extra
  const { baseSelector, extraSelectors } = context;

  // Base
  const baseNodes = document.querySelectorAll(baseSelector);
  removeNodes(baseNodes);

  // Extra
  if (extraSelectors.length > 0) {
    const combinedExtra = extraSelectors.join(',');
    const extraNodes = document.querySelectorAll(combinedExtra);
    removeNodes(extraNodes);
  }

  // Candidates
  const candidates = document.querySelectorAll(context.candidateSelector);
  for (let i = candidates.length - 1; i >= 0; i--) {
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
  for (const el of Array.from(elements)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') processUrlElement(el, 'href', base, false);
    else if (tag === 'img') processUrlElement(el, 'src', base, false);
    else if (tag === 'source') processUrlElement(el, 'srcset', base, true);
  }
}

function serialize(document: Document, fallback: string): string {
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

export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string
): string {
  const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
  if (!shouldParse) return html;

  try {
    const context = getContext();

    if (config.noiseRemoval.debug) {
      logDebug('Noise removal audit enabled', {
        categories: [...(context.flags.navFooter ? ['nav-footer'] : [])],
      });
    }

    const doc = document ?? parseHTML(html).document;

    stripNoise(doc, context);

    if (baseUrl) resolveUrls(doc, baseUrl);

    return serialize(doc, html);
  } catch {
    return html;
  }
}
