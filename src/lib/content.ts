import { parseHTML } from 'linkedom';

import { type MetadataBlock } from '../transform/types.js';
import { config, logDebug } from './core.js';
import { throwIfAborted } from './utils.js';

// ASCII char codes used in hot-path charCodeAt comparisons
const ASCII_SPACE = 32;
const ASCII_TAB = 9;
const ASCII_EXCLAMATION = 33;
const ASCII_HASH = 35;
const ASCII_ASTERISK = 42;
const ASCII_PLUS = 43;
const ASCII_DASH = 45;
const ASCII_PERIOD = 46;
const ASCII_DIGIT_0 = 48;
const ASCII_DIGIT_9 = 57;
const ASCII_LT = 60;
const ASCII_QUESTION = 63;
const ASCII_UPPER_A = 65;
const ASCII_UPPER_Z = 90;
const ASCII_BRACKET_OPEN = 91;
const ASCII_LOWER_A = 97;
const ASCII_LOWER_Z = 122;
const ASCII_UNDERSCORE = 95;
const HTML_TAG_DENSITY_LIMIT = 5;
const TITLE_MIN_WORDS = 2;
const TITLE_MAX_WORDS = 6;
const TITLE_MIN_CAPITALIZED = 2;
const PROPERTY_FIX_MAX_PASSES = 3;
const BODY_SCAN_LIMIT = 5000;
const HAS_FOLLOWING_LOOKAHEAD = 50;
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
    for (const node of cell.childNodes) {
      const text = node.textContent;
      if (node.nodeType === 3 && text?.includes('|')) {
        node.textContent = text.replace(/\|/g, '\\|');
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

// endregion

// region Language Detection

class DetectionContext {
  private _lower: string | undefined;
  private _lines: readonly string[] | undefined;
  private _trimmedStart: string | undefined;

  constructor(readonly code: string) {}

  get lower(): string {
    this._lower ??= this.code.toLowerCase();
    return this._lower;
  }

  get lines(): readonly string[] {
    this._lines ??= this.code.split(/\r?\n/);
    return this._lines;
  }

  get trimmedStart(): string {
    this._trimmedStart ??= this.code.trimStart();
    return this._trimmedStart;
  }
}
const BASH_COMMANDS = new Set([
  'sudo',
  'chmod',
  'mkdir',
  'cd',
  'ls',
  'cat',
  'echo',
]);
const BASH_PACKAGE_MANAGERS = [
  'npm',
  'yarn',
  'pnpm',
  'npx',
  'brew',
  'apt',
  'pip',
  'cargo',
  'go',
] as const;
const BASH_VERBS = new Set(['install', 'add', 'run', 'build', 'start']);
const TYPESCRIPT_HINTS = [
  ': string',
  ':string',
  ': number',
  ':number',
  ': boolean',
  ':boolean',
  ': void',
  ':void',
  ': any',
  ':any',
  ': unknown',
  ':unknown',
  ': never',
  ':never',
];
const HTML_TAGS = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<div',
  '<span',
  '<p',
  '<a',
  '<script',
  '<style',
];
const RUST_REGEX = /\b(?:fn|impl|struct|enum)\b/;
const JS_REGEX =
  /\b(?:const|let|var|function|class|async|await|export|import)\b/;
const PYTHON_UNIQUE_REGEX =
  /\b(?:def |elif |except |finally:|yield |lambda |raise |pass$)/m;
const JS_SIGNAL_REGEX =
  /\b(?:const |let |var |function |require\(|=>|===|!==|console\.)/;
const CSS_REGEX = /@media|@import|@keyframes/;
const CSS_PROPERTY_REGEX = /^\s*[a-z][\w-]*\s*:/;
function containsJsxTag(code: string): boolean {
  const len = code.length;
  for (let i = 0; i < len - 1; i++) {
    if (code.charCodeAt(i) === ASCII_LT) {
      const next = code.charCodeAt(i + 1);
      if (next >= ASCII_UPPER_A && next <= ASCII_UPPER_Z) return true;
    }
  }
  return false;
}
function isBashLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return false;

  // Shell Prefix
  if (
    trimmed.startsWith('#!') ||
    trimmed.startsWith('$ ') ||
    trimmed.startsWith('# ')
  ) {
    return true;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  if (BASH_COMMANDS.has(firstWord)) return true;

  // Package Managers
  const isPkgMgr = BASH_PACKAGE_MANAGERS.includes(
    firstWord as (typeof BASH_PACKAGE_MANAGERS)[number]
  );

  if (isPkgMgr && spaceIdx !== -1) {
    const rest = trimmed.slice(spaceIdx + 1);
    const secondSpaceIdx = rest.indexOf(' ');
    const secondWord =
      secondSpaceIdx === -1 ? rest : rest.slice(0, secondSpaceIdx);
    if (BASH_VERBS.has(secondWord)) return true;
  }

  return false;
}
function detectBashIndicators(lines: readonly string[]): boolean {
  return lines.some((line) => isBashLine(line));
}
function detectCssStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;

    const hasSelector =
      (trimmed.startsWith('.') || trimmed.startsWith('#')) &&
      trimmed.includes('{');

    if (hasSelector) return true;
    if (
      trimmed.includes(';') &&
      CSS_PROPERTY_REGEX.test(trimmed) &&
      !trimmed.includes('(')
    ) {
      return true;
    }
  }
  return false;
}
function detectYamlStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;

    const after = trimmed.charCodeAt(colonIdx + 1);
    if (after === ASCII_SPACE || after === ASCII_TAB) return true;
  }
  return false;
}
type Matcher = (ctx: DetectionContext) => boolean;
interface LanguageDef {
  lang: string;
  weight: number;
  match: Matcher;
}
function matchRust(ctx: DetectionContext): boolean {
  if (ctx.lower.includes('let mut')) return true;
  if (RUST_REGEX.test(ctx.lower)) return true;
  return ctx.lower.includes('use ') && ctx.lower.includes('::');
}
function matchGo(ctx: DetectionContext): boolean {
  if (ctx.lower.includes('import "')) return true;
  return /\b(?:package|func)\b/.test(ctx.lower);
}
function matchJsx(ctx: DetectionContext): boolean {
  const l = ctx.lower;
  if (
    l.includes('classname=') ||
    l.includes('jsx:') ||
    l.includes("from 'react'") ||
    l.includes('from "react"')
  ) {
    return true;
  }
  return containsJsxTag(ctx.code);
}
function matchTypeScript(ctx: DetectionContext): boolean {
  if (/\b(?:interface|type)\b/.test(ctx.lower)) return true;
  const l = ctx.lower;
  for (const hint of TYPESCRIPT_HINTS) {
    if (l.includes(hint)) return true;
  }
  return false;
}
function matchSql(ctx: DetectionContext): boolean {
  return /\b(?:select|insert|update|delete|create|alter|drop)\b/.test(
    ctx.lower
  );
}
function hasJsSignals(lowerCode: string): boolean {
  return (
    JS_SIGNAL_REGEX.test(lowerCode) ||
    lowerCode.includes('{') ||
    lowerCode.includes("from '")
  );
}

function matchPython(ctx: DetectionContext): boolean {
  const l = ctx.lower;
  if (l.includes('print(') || l.includes('__name__')) return true;
  if (l.includes('self.') || l.includes('elif ')) return true;
  // Check for Python's None/True/False using original case (they are capitalized in Python)
  if (
    ctx.code.includes('None') ||
    ctx.code.includes('True') ||
    ctx.code.includes('False')
  ) {
    return true;
  }
  if (PYTHON_UNIQUE_REGEX.test(l)) return true;
  // Shared keywords (import, from, class) — only match if no JS signals present
  if (/\b(?:import|from|class)\b/.test(l) && !hasJsSignals(l)) {
    return true;
  }
  return false;
}
function matchHtml(ctx: DetectionContext): boolean {
  const l = ctx.lower;
  for (const tag of HTML_TAGS) {
    if (l.includes(tag)) return true;
  }
  return false;
}

// Pre-sorted by weight descending — first match wins in detectLanguageFromCode
const LANGUAGES: LanguageDef[] = [
  { lang: 'rust', weight: 25, match: matchRust },
  { lang: 'go', weight: 22, match: matchGo },
  { lang: 'jsx', weight: 22, match: matchJsx },
  { lang: 'typescript', weight: 20, match: matchTypeScript },
  { lang: 'sql', weight: 20, match: matchSql },
  { lang: 'python', weight: 18, match: matchPython },
  {
    lang: 'css',
    weight: 18,
    match: (ctx) => CSS_REGEX.test(ctx.lower) || detectCssStructure(ctx.lines),
  },
  { lang: 'bash', weight: 15, match: (ctx) => detectBashIndicators(ctx.lines) },
  { lang: 'yaml', weight: 15, match: (ctx) => detectYamlStructure(ctx.lines) },
  { lang: 'javascript', weight: 15, match: (ctx) => JS_REGEX.test(ctx.lower) },
  { lang: 'html', weight: 12, match: matchHtml },
  {
    lang: 'json',
    weight: 10,
    match: (ctx) =>
      ctx.trimmedStart.startsWith('{') || ctx.trimmedStart.startsWith('['),
  },
];
export function extractLanguageFromClassName(
  className: string
): string | undefined {
  if (!className) return undefined;

  // Split by whitespace and check for language indicators
  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;

  // Fast path: check for prefixes
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice(9);
    if (lower.startsWith('lang-')) return token.slice(5);
    if (lower.startsWith('highlight-')) return token.slice(10);
  }

  // Fallback: check for hljs context
  if (!tokens.includes('hljs')) return undefined;

  const langClass = tokens.find((t) => {
    const l = t.toLowerCase();
    return l !== 'hljs' && !l.startsWith('hljs-');
  });
  return langClass;
}
function resolveLanguageFromDataAttribute(
  dataLang: string
): string | undefined {
  const trimmed = dataLang.trim();
  if (!trimmed) return undefined;

  // Check if \w+
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    const isUpper = c >= ASCII_UPPER_A && c <= ASCII_UPPER_Z;
    const isLower = c >= ASCII_LOWER_A && c <= ASCII_LOWER_Z;
    const isDigit = c >= ASCII_DIGIT_0 && c <= ASCII_DIGIT_9;
    const isUnder = c === ASCII_UNDERSCORE;

    if (!isUpper && !isLower && !isDigit && !isUnder) {
      return undefined;
    }
  }
  return trimmed;
}
export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  return (
    extractLanguageFromClassName(className) ??
    resolveLanguageFromDataAttribute(dataLang)
  );
}
export function detectLanguageFromCode(code: string): string | undefined {
  if (!code) return undefined;

  // Fast path for empty/whitespace only
  let empty = true;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) > ASCII_SPACE) {
      empty = false;
      break;
    }
  }
  if (empty) return undefined;

  const ctx = new DetectionContext(code);

  // LANGUAGES is pre-sorted by weight descending — first match is highest confidence
  for (const def of LANGUAGES) {
    if (def.match(ctx)) return def.lang;
  }

  return undefined;
}

// endregion

// region Markdown Cleanup

const MAX_LINE_LENGTH = 80;
const REGEX = {
  HEADING_MARKER: /^#{1,6}\s/m,
  HEADING_STRICT: /^#{1,6}\s+/m,
  EMPTY_HEADING_LINE: /^#{1,6}[ \t\u00A0]*$/,
  ANCHOR_ONLY_HEADING: /^#{1,6}\s+\[[^\]]+\]\(#[^)]+\)\s*$/,
  FENCE_START: /^\s*(`{3,}|~{3,})/,
  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,
  TOC_HEADING:
    /^(?:#{1,6}\s+)?(?:table of contents|contents|on this page)\s*$/i,
  HTML_DOC_START: /^(<!doctype|<html)/i,
  COMBINED_LINE_REMOVALS:
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??|\[Back to top\]\(#[^)]*\)|\[\s*\]\(https?:\/\/[^)]*\))\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,
  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
  SOURCE_KEY: /^source:\s/im,
  HEADING_SPACING: /(^#{1,6}\s[^\n]*)\n([^\n])/gm,
  HEADING_CODE_BLOCK: /(^#{1,6}\s+\w+)```/gm,
  SPACING_LINK_FIX: /\]\(([^)]+)\)\[/g,
  SPACING_ADJ_COMBINED: /(?:\]\([^)]+\)|`[^`]+`)(?=[A-Za-z0-9])/g,
  SPACING_CODE_DASH: /(`[^`]+`)\s*\\-\s*/g,
  SPACING_ESCAPES: /\\([[\].])/g,
  SPACING_LIST_NUM_COMBINED:
    /^((?![-*+] |\d+\. |[ \t]).+)\n((?:[-*+]|\d+\.) )/gm,
  PUNCT_ONLY_LIST_ARTIFACT:
    /^(?:[-*+]|\d+\.)\s*(?:\\[-*+|/]|[-*+|/])(?:\s+(?:\\[-*+|/]|[-*+|/]))*\s*$/gm,
  NESTED_LIST_INDENT: /^( +)((?:[-*+])|\d+\.)\s/gm,
  TYPEDOC_COMMENT: /(`+)(?:(?!\1)[\s\S])*?\1|\s?\/\\?\*[\s\S]*?\\?\*\//g,
} as const;
const HEADING_KEYWORDS = new Set(
  config.markdownCleanup.headingKeywords.map((value) =>
    value.toLocaleLowerCase(config.i18n.locale)
  )
);
const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;
const TOC_SCAN_LIMIT = 20;
const TOC_MAX_NON_EMPTY = 12;
const TOC_LINK_RATIO_THRESHOLD = 0.8;
const TYPEDOC_PREFIXES = [
  'Defined in:',
  'Returns:',
  'Since:',
  'See also:',
] as const;
interface CleanupOptions {
  signal?: AbortSignal;
  url?: string;
}
function createAbortChecker(options?: CleanupOptions): (stage: string) => void {
  const signal = options?.signal;
  const url = options?.url ?? '';
  return (stage: string): void => {
    throwIfAborted(signal, url, stage);
  };
}
function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}
function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}
function hasFollowingContent(lines: string[], startIndex: number): boolean {
  // Optimization: Bound lookahead to avoid checking too many lines in huge files
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + HAS_FOLLOWING_LOOKAHEAD);
    i++
  ) {
    if (!isBlank(lines[i])) return true;
  }
  return false;
}
function isTitleCaseOrKeyword(trimmed: string): boolean {
  // Quick check for length to avoid regex on long strings
  if (trimmed.length > MAX_LINE_LENGTH) return false;

  // Single word optimization
  if (!trimmed.includes(' ')) {
    if (!/^[A-Z]/.test(trimmed)) return false;
    return HEADING_KEYWORDS.has(trimmed.toLocaleLowerCase(config.i18n.locale));
  }

  // Split limited number of words
  const words = trimmed.split(/\s+/);
  const len = words.length;
  if (len < TITLE_MIN_WORDS || len > TITLE_MAX_WORDS) return false;

  let capitalizedCount = 0;
  for (let i = 0; i < len; i++) {
    const w = words[i];
    if (!w) continue;
    const isCap = /^[A-Z][a-z]*$/.test(w);
    if (isCap) capitalizedCount++;
    else if (!/^(?:and|or|the|of|in|for|to|a)$/i.test(w)) return false;
  }

  return capitalizedCount >= TITLE_MIN_CAPITALIZED;
}
function getHeadingPrefix(trimmed: string): string | null {
  if (trimmed.length > MAX_LINE_LENGTH) return null;

  // Fast path: Check common markdown markers first
  const firstChar = trimmed.charCodeAt(0);
  if (
    firstChar === ASCII_HASH ||
    firstChar === ASCII_DASH ||
    firstChar === ASCII_ASTERISK ||
    firstChar === ASCII_PLUS ||
    firstChar === ASCII_BRACKET_OPEN ||
    (firstChar >= ASCII_DIGIT_0 && firstChar <= ASCII_DIGIT_9)
  ) {
    if (
      REGEX.HEADING_MARKER.test(trimmed) ||
      REGEX.LIST_MARKER.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) ||
      /^\[.*\]\(.*\)$/.test(trimmed)
    ) {
      return null;
    }
  }

  if (SPECIAL_PREFIXES.test(trimmed)) {
    return /^example:\s/i.test(trimmed) ? '### ' : '## ';
  }

  const lastChar = trimmed.charCodeAt(trimmed.length - 1);
  if (
    lastChar === ASCII_PERIOD ||
    lastChar === ASCII_EXCLAMATION ||
    lastChar === ASCII_QUESTION
  )
    return null;

  return isTitleCaseOrKeyword(trimmed) ? '## ' : null;
}
function getTocBlockStats(
  lines: string[],
  headingIndex: number
): { total: number; linkCount: number; nonLinkCount: number } {
  let total = 0;
  let linkCount = 0;
  let nonLinkCount = 0;
  const lookaheadMax = Math.min(lines.length, headingIndex + TOC_SCAN_LIMIT);

  for (let i = headingIndex + 1; i < lookaheadMax; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (REGEX.HEADING_MARKER.test(trimmed)) break;

    total += 1;
    if (REGEX.TOC_LINK.test(trimmed)) linkCount += 1;
    else nonLinkCount += 1;

    if (total >= TOC_MAX_NON_EMPTY) break;
  }

  return { total, linkCount, nonLinkCount };
}
function skipTocLines(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!REGEX.TOC_LINK.test(trimmed)) return i;
  }
  return lines.length;
}
function isTypeDocArtifactLine(line: string): boolean {
  const trimmed = line.trim();
  for (const prefix of TYPEDOC_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length).trimStart();
    if (!rest.startsWith('**`')) return false;
    return rest.includes('`**');
  }
  return false;
}
function tryPromoteOrphan(
  lines: string[],
  i: number,
  trimmed: string
): string | null {
  const prevLine = lines[i - 1];
  const isOrphan = i === 0 || !prevLine || prevLine.trim().length === 0;
  if (!isOrphan) return null;

  const prefix = getHeadingPrefix(trimmed);
  if (!prefix) return null;

  const isSpecialPrefix = SPECIAL_PREFIXES.test(trimmed);
  if (!isSpecialPrefix && !hasFollowingContent(lines, i)) return null;

  return `${prefix}${trimmed}`;
}
function shouldSkipAsToc(
  lines: string[],
  i: number,
  trimmed: string,
  removeToc: boolean,
  options?: CleanupOptions
): number | null {
  if (!removeToc || !REGEX.TOC_HEADING.test(trimmed)) return null;

  const { total, linkCount, nonLinkCount } = getTocBlockStats(lines, i);
  if (total === 0 || nonLinkCount > 0) return null;

  const ratio = linkCount / total;
  if (ratio <= TOC_LINK_RATIO_THRESHOLD) return null;

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:toc');
  return skipTocLines(lines, i + 1);
}
function preprocessLines(lines: string[], options?: CleanupOptions): string {
  const processedLines: string[] = [];
  const len = lines.length;
  const promote = config.markdownCleanup.promoteOrphanHeadings;
  const removeToc = config.markdownCleanup.removeTocBlocks;
  const checkAbort = createAbortChecker(options);

  let skipUntil = -1;

  for (let i = 0; i < len; i++) {
    if (i < skipUntil) continue;

    let line = lines[i];
    if (line === undefined) continue;

    const trimmed = line.trim();
    if (REGEX.EMPTY_HEADING_LINE.test(trimmed)) continue;
    if (
      REGEX.ANCHOR_ONLY_HEADING.test(trimmed) &&
      !hasFollowingContent(lines, i)
    )
      continue;

    const tocSkip = shouldSkipAsToc(lines, i, trimmed, removeToc, options);
    if (tocSkip !== null) {
      skipUntil = tocSkip;
      continue;
    }

    if (promote && trimmed.length > 0) {
      checkAbort('markdown:cleanup:promote');
      const promoted = tryPromoteOrphan(lines, i, trimmed);
      if (promoted) line = promoted;
    }

    processedLines.push(line);
  }
  return processedLines.join('\n');
}
function processTextBuffer(lines: string[], options?: CleanupOptions): string {
  if (lines.length === 0) return '';
  const text = preprocessLines(lines, options);
  return applyGlobalRegexes(text, options);
}
function removeTypeDocArtifacts(text: string): string {
  const filtered = text
    .split('\n')
    .filter((line) => !isTypeDocArtifactLine(line))
    .join('\n');
  return filtered.replace(REGEX.TYPEDOC_COMMENT, (match) =>
    match.startsWith('`') ? match : ''
  );
}
function removeSkipLinks(text: string): string {
  return text
    .replace(REGEX.ZERO_WIDTH_ANCHOR, '')
    .replace(REGEX.COMBINED_LINE_REMOVALS, '');
}
function normalizeMarkdownSpacing(text: string): string {
  let result = text
    .replace(REGEX.SPACING_LINK_FIX, ']($1)\n\n[')
    .replace(REGEX.SPACING_ADJ_COMBINED, '$& ')
    .replace(REGEX.SPACING_CODE_DASH, '$1 - ')
    .replace(REGEX.SPACING_ESCAPES, '$1')
    .replace(REGEX.SPACING_LIST_NUM_COMBINED, '$1\n\n$2')
    .replace(REGEX.PUNCT_ONLY_LIST_ARTIFACT, '')
    .replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');

  // Trim leading whitespace inside inline code spans
  result = result.replace(/(?<=\s|^)`\s+([^`]+)`/gm, '`$1`');

  // Unescape backticks inside markdown link text
  result = result.replace(
    /\[([^\]]*\\`[^\]]*)\]\(([^)]+)\)/g,
    (_match: string, linkText: string, url: string) =>
      `[${linkText.replace(/\\`/g, '`')}](${url})`
  );
  result = result.replace(
    /\[([^\]]*<[^\]]*)\]\(([^)]+)\)/g,
    (_match: string, linkText: string, url: string) =>
      `[${linkText.replace(/</g, '\\<').replace(/>/g, '\\>')}](${url})`
  );

  return normalizeNestedListIndentation(result);
}
function fixConcatenatedProperties(text: string): string {
  let result = text;
  for (let k = 0; k < PROPERTY_FIX_MAX_PASSES; k++) {
    const next = result.replace(REGEX.CONCATENATED_PROPS, '$1$2\n\n$3');
    if (next === result) break;
    result = next;
  }
  return result;
}
function applyGlobalRegexes(text: string, options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);

  let result = text.replace(/\u00A0/g, ' ');

  checkAbort('markdown:cleanup:headings');
  result = result
    .replace(REGEX.HEADING_SPACING, '$1\n\n$2')
    .replace(REGEX.HEADING_CODE_BLOCK, '$1\n\n```');

  if (config.markdownCleanup.removeTypeDocComments) {
    checkAbort('markdown:cleanup:typedoc');
    result = removeTypeDocArtifacts(result);
  }
  if (config.markdownCleanup.removeSkipLinks) {
    checkAbort('markdown:cleanup:skip-links');
    result = removeSkipLinks(result);
  }

  checkAbort('markdown:cleanup:spacing');
  result = normalizeMarkdownSpacing(result);

  checkAbort('markdown:cleanup:properties');
  return fixConcatenatedProperties(result);
}
function normalizeNestedListIndentation(text: string): string {
  return text.replace(
    REGEX.NESTED_LIST_INDENT,
    (match: string, spaces: string, marker: string): string => {
      const count = spaces.length;
      if (count < 2 || count % 2 !== 0) return match;
      const normalized = ' '.repeat((count / 2) * 4);
      return `${normalized}${marker} `;
    }
  );
}
export function cleanupMarkdownArtifacts(
  content: string,
  options?: CleanupOptions
): string {
  if (!content) return '';

  const checkAbort = createAbortChecker(options);
  checkAbort('markdown:cleanup:begin');

  const lines = content.split(/\r?\n/);
  let fenceMarker: string | null = null;
  const segments: string[] = [];
  let buffer: string[] = [];

  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      segments.push(processTextBuffer(buffer, options));
      buffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (fenceMarker) {
      segments.push(line);
      if (
        trimmed.startsWith(fenceMarker) &&
        trimmed.slice(fenceMarker.length).trim() === ''
      ) {
        fenceMarker = null;
      }
    } else {
      const match = REGEX.FENCE_START.exec(line);
      const newMarker = match ? (match[1] ?? '```') : null;
      if (!newMarker) {
        buffer.push(line);
      } else {
        flushBuffer();
        segments.push(line);
        fenceMarker = newMarker;
      }
    }
  }

  flushBuffer();

  return segments.join('\n').trim();
}

// endregion

// region Frontmatter & Source Injection

interface FrontmatterRange {
  start: number;
  end: number;
  linesStart: number;
  linesEnd: number;
  lineEnding: '\n' | '\r\n';
}
interface FrontmatterResult {
  range: FrontmatterRange;
  entries: Map<string, string>;
}
function parseFrontmatter(content: string): FrontmatterResult | null {
  const len = content.length;
  if (len < 4) return null;

  let lineEnding: '\n' | '\r\n' | null = null;
  let fenceLen = 0;

  if (content.startsWith('---\n')) {
    lineEnding = '\n';
    fenceLen = 4;
  } else if (content.startsWith('---\r\n')) {
    lineEnding = '\r\n';
    fenceLen = 5;
  }

  if (!lineEnding) return null;

  const fence = `---${lineEnding}`;
  const closeIndex = content.indexOf(fence, fenceLen);
  if (closeIndex === -1) return null;

  const range: FrontmatterRange = {
    start: 0,
    end: closeIndex + fenceLen,
    linesStart: fenceLen,
    linesEnd: closeIndex,
    lineEnding,
  };

  // Parse key-value entries in one pass
  const entries = new Map<string, string>();
  const fmBody = content.slice(range.linesStart, range.linesEnd);
  let lastIdx = 0;
  while (lastIdx < fmBody.length) {
    let nextIdx = fmBody.indexOf(lineEnding, lastIdx);
    if (nextIdx === -1) nextIdx = fmBody.length;

    const line = fmBody.slice(lastIdx, nextIdx).trim();
    const colonIdx = line.indexOf(':');
    if (line && colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      let value = line.slice(colonIdx + 1).trim();
      // Strip surrounding quotes
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim();
      }
      if (value) entries.set(key, value);
    }
    lastIdx = nextIdx + lineEnding.length;
  }

  return { range, entries };
}
function scanBodyForTitle(content: string): string | undefined {
  const len = content.length;
  let scanIndex = 0;
  const maxScan = Math.min(len, BODY_SCAN_LIMIT);

  while (scanIndex < maxScan) {
    let nextIndex = content.indexOf('\n', scanIndex);
    if (nextIndex === -1) nextIndex = len;

    let line = content.slice(scanIndex, nextIndex);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    const trimmed = line.trim();
    if (trimmed) {
      if (REGEX.HEADING_STRICT.test(trimmed)) {
        return trimmed.replace(REGEX.HEADING_MARKER, '').trim() || undefined;
      }
      return undefined;
    }

    scanIndex = nextIndex + 1;
  }
  return undefined;
}
export function extractTitleFromRawMarkdown(
  content: string
): string | undefined {
  const fm = parseFrontmatter(content);
  if (fm) {
    const title = fm.entries.get('title') ?? fm.entries.get('name');
    if (title) return title;
  }
  return scanBodyForTitle(content);
}
export function addSourceToMarkdown(content: string, url: string): string {
  const fm = parseFrontmatter(content);
  const useMarkdownFormat = config.transform.metadataFormat === 'markdown';

  if (useMarkdownFormat && !fm) {
    if (REGEX.SOURCE_KEY.test(content)) return content;
    const lineEnding = getLineEnding(content);
    const firstH1Match = REGEX.HEADING_MARKER.exec(content);

    if (firstH1Match) {
      const h1Index = firstH1Match.index;
      const lineEndIndex = content.indexOf(lineEnding, h1Index);
      const insertPos =
        lineEndIndex === -1 ? content.length : lineEndIndex + lineEnding.length;

      const injection = `${lineEnding}Source: ${url}${lineEnding}`;
      return content.slice(0, insertPos) + injection + content.slice(insertPos);
    }

    return `Source: ${url}${lineEnding}${lineEnding}${content}`;
  }

  if (!fm) {
    const lineEnding = getLineEnding(content);
    const escapedUrl = url.replace(/"/g, '\\"');
    return `---${lineEnding}source: "${escapedUrl}"${lineEnding}---${lineEnding}${lineEnding}${content}`;
  }

  const fmBody = content.slice(fm.range.linesStart, fm.range.linesEnd);
  if (REGEX.SOURCE_KEY.test(fmBody)) return content;

  const escapedUrl = url.replace(/"/g, '\\"');
  const injection = `source: "${escapedUrl}"${fm.range.lineEnding}`;

  return (
    content.slice(0, fm.range.linesEnd) +
    injection +
    content.slice(fm.range.linesEnd)
  );
}

// endregion

// region Content Detection & Metadata Footer

function countCommonTags(content: string, limit: number): number {
  if (limit <= 0) return 0;

  const regex = /<(html|head|body|div|span|script|style|meta|link)\b/gi;

  let count = 0;
  while (regex.exec(content)) {
    count += 1;
    if (count > limit) break;
  }

  return count;
}
export function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  if (REGEX.HTML_DOC_START.test(trimmed)) return false;

  if (parseFrontmatter(trimmed) !== null) return true;

  const tagCount = countCommonTags(content, HTML_TAG_DENSITY_LIMIT);
  if (tagCount > HTML_TAG_DENSITY_LIMIT) return false;

  return (
    REGEX.HEADING_MARKER.test(content) ||
    REGEX.LIST_MARKER.test(content) ||
    content.includes('```')
  );
}
function formatFetchedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatter = new Intl.DateTimeFormat(config.i18n.locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return formatter.format(date);
}
export function buildMetadataFooter(
  metadata?: MetadataBlock,
  fallbackUrl?: string
): string {
  if (!metadata) return '';

  const lines: string[] = ['---', ''];
  const url = metadata.url || fallbackUrl;

  const parts: string[] = [];
  if (metadata.title) parts.push(`_${metadata.title}_`);
  if (metadata.author) parts.push(`_${metadata.author}_`);
  if (url) parts.push(`[_Original Source_](${url})`);

  if (metadata.fetchedAt) {
    parts.push(`_${formatFetchedAt(metadata.fetchedAt)}_`);
  }

  if (parts.length > 0) lines.push(` ${parts.join(' | ')}`);
  if (metadata.description) lines.push(` <sub>${metadata.description}</sub>`);

  return lines.join('\n');
}

// endregion
