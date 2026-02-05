import { parseHTML } from 'linkedom';

import { config } from './config.js';
import { logDebug } from './observability.js';
import { isObject } from './type-guards.js';

const NOISE_SCAN_LIMIT = 50_000;
const MIN_BODY_CONTENT_LENGTH = 100;
const DIALOG_MIN_CHARS_FOR_PRESERVATION = 500;

const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
const NOISE_TAGS_PATTERN =
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i;
const NOISE_ROLES_PATTERN =
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i;
const NOISE_OTHER_ATTRS_PATTERN =
  /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i;
const NOISE_CLASSES_PATTERN =
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast|fixed|sticky|z-50|z-4|isolate|breadcrumb|pagination)\b/i;

const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_PATTERN = /\b(fixed|sticky)\b/;
const HIGH_Z_PATTERN = /\bz-(?:4\d|50)\b/;
const ISOLATE_PATTERN = /\bisolate\b/;

const SKIP_URL_PREFIXES = [
  '#',
  'java' + 'script:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
] as const;

const BASE_STRUCTURAL_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'textarea',
] as const;

const ALWAYS_NOISE_TAGS: ReadonlySet<string> = new Set(['nav', 'footer']);

const NAVIGATION_ROLES: ReadonlySet<string> = new Set([
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

const INTERACTIVE_CONTENT_ROLES: ReadonlySet<string> = new Set([
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

const NOISE_CATEGORY = {
  cookieBanners: 'cookie-banners',
  navFooter: 'nav-footer',
  newsletters: 'newsletters',
  socialShare: 'social-share',
} as const;

const PROMO_TOKENS_ALWAYS: readonly string[] = [
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

const PROMO_TOKENS_AGGRESSIVE: readonly string[] = ['ad', 'related', 'comment'];

const PROMO_TOKENS_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  [NOISE_CATEGORY.cookieBanners]: [
    'cookie',
    'consent',
    'popup',
    'modal',
    'overlay',
    'toast',
  ],
  [NOISE_CATEGORY.newsletters]: ['newsletter', 'subscribe'],
  [NOISE_CATEGORY.socialShare]: ['share', 'social'],
};

const BASE_NOISE_SELECTORS = {
  navFooter: [
    'nav',
    'footer',
    'header[class*="site"]',
    'header[class*="nav"]',
    'header[class*="menu"]',
    '[role="banner"]',
    '[role="navigation"]',
  ],
  cookieBanners: ['[role="dialog"]'],
  hidden: [
    '[style*="display: none"]',
    '[style*="display:none"]',
    '[hidden]',
    '[aria-hidden="true"]',
  ],
} as const;

const NO_MATCH_REGEX = /a^/i;

type NoiseRemovalConfig = typeof config.noiseRemoval;
type NoiseWeights = NoiseRemovalConfig['weights'];
type NodeCollection = Iterable<Element> | ArrayLike<Element>;

interface ElementMetadata {
  readonly tagName: string;
  readonly className: string;
  readonly id: string;
  readonly role: string | null;
  readonly isHidden: boolean;
  readonly isInteractive: boolean;
}

interface CategoryFlags {
  readonly navFooter: boolean;
  readonly cookieBanners: boolean;
  readonly newsletters: boolean;
  readonly socialShare: boolean;
}

interface PromoMatchResult {
  readonly matched: boolean;
  readonly aggressive: boolean;
}

interface PromoTokenMatchers {
  readonly base: RegExp;
  readonly aggressive: RegExp;
}

interface NoiseContext {
  readonly enabledCategories: ReadonlySet<string>;
  readonly flags: CategoryFlags;
  readonly structuralTags: ReadonlySet<string>;
  readonly weights: NoiseWeights;
  readonly promoMatchers: PromoTokenMatchers;
  readonly promoEnabled: boolean;
  readonly extraSelectors: readonly string[];
}

function normalizeCategories(categories: readonly string[]): Set<string> {
  return new Set(categories.map((entry) => entry.toLowerCase().trim()));
}

function isCategoryEnabled(
  category: string,
  enabled: ReadonlySet<string>
): boolean {
  return enabled.has(category.toLowerCase());
}

function createCategoryFlags(enabled: ReadonlySet<string>): CategoryFlags {
  return {
    navFooter: isCategoryEnabled(NOISE_CATEGORY.navFooter, enabled),
    cookieBanners: isCategoryEnabled(NOISE_CATEGORY.cookieBanners, enabled),
    newsletters: isCategoryEnabled(NOISE_CATEGORY.newsletters, enabled),
    socialShare: isCategoryEnabled(NOISE_CATEGORY.socialShare, enabled),
  };
}

function getStructuralTags(preserveSvgCanvas: boolean): Set<string> {
  const tags = new Set<string>(BASE_STRUCTURAL_TAGS);
  if (!preserveSvgCanvas) {
    tags.add('svg');
    tags.add('canvas');
  }
  return tags;
}

function normalizeSelectors(selectors: readonly string[]): string[] {
  return selectors
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

function createNoiseContext(options: NoiseRemovalConfig): NoiseContext {
  const enabledCategories = normalizeCategories(options.enabledCategories);
  const flags = createCategoryFlags(enabledCategories);
  const structuralTags = getStructuralTags(options.preserveSvgCanvas);
  const promoMatchers = buildPromoTokenMatchers(
    enabledCategories,
    options.aggressiveMode,
    options.extraTokens
  );
  const promoEnabled =
    flags.cookieBanners || flags.newsletters || flags.socialShare;
  const extraSelectors = normalizeSelectors(options.extraSelectors);

  return {
    enabledCategories,
    flags,
    structuralTags,
    weights: options.weights,
    promoMatchers,
    promoEnabled,
    extraSelectors,
  };
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTokenRegex(tokens: ReadonlySet<string>): RegExp {
  if (tokens.size === 0) return NO_MATCH_REGEX;
  const escaped = [...tokens].map(escapeRegexLiteral);
  return new RegExp(
    `(?:^|[^a-z0-9])(?:${escaped.join('|')})(?:$|[^a-z0-9])`,
    'i'
  );
}

function collectPromoTokens(
  enabled: ReadonlySet<string>,
  aggressiveMode: boolean,
  extraTokens: readonly string[]
): { base: Set<string>; aggressive: Set<string> } {
  const base = new Set<string>(PROMO_TOKENS_ALWAYS);
  const aggressive = new Set<string>();

  if (aggressiveMode) {
    for (const token of PROMO_TOKENS_AGGRESSIVE) {
      aggressive.add(token);
    }
  }

  for (const [category, categoryTokens] of Object.entries(
    PROMO_TOKENS_BY_CATEGORY
  )) {
    if (!isCategoryEnabled(category, enabled)) continue;
    for (const token of categoryTokens) {
      base.add(token);
    }
  }

  for (const token of extraTokens) {
    const normalized = token.toLowerCase().trim();
    if (normalized) base.add(normalized);
  }

  return { base, aggressive };
}

function buildPromoTokenMatchers(
  enabled: ReadonlySet<string>,
  aggressiveMode: boolean,
  extraTokens: readonly string[]
): PromoTokenMatchers {
  const tokens = collectPromoTokens(enabled, aggressiveMode, extraTokens);
  return {
    base: buildTokenRegex(tokens.base),
    aggressive: buildTokenRegex(tokens.aggressive),
  };
}

function matchPromoTokens(
  matchers: PromoTokenMatchers,
  className: string,
  id: string
): PromoMatchResult {
  const aggressiveMatch =
    matchers.aggressive.test(className) || matchers.aggressive.test(id);
  if (aggressiveMatch) return { matched: true, aggressive: true };

  const baseMatch = matchers.base.test(className) || matchers.base.test(id);
  return { matched: baseMatch, aggressive: false };
}

function getAttr(element: Element, name: string): string {
  return element.getAttribute(name) ?? '';
}

function safeQuerySelectorAll(
  document: Document,
  selector: string
): NodeListOf<Element> | null {
  try {
    return document.querySelectorAll(selector);
  } catch {
    return null;
  }
}

function removeMatchingNodes(
  nodes: NodeCollection,
  shouldRemove: (node: Element) => boolean
): void {
  for (const node of Array.from(nodes)) {
    if (shouldRemove(node)) node.remove();
  }
}

function isElementHidden(element: Element): boolean {
  const style = getAttr(element, 'style');
  return (
    element.getAttribute('hidden') !== null ||
    element.getAttribute('aria-hidden') === 'true' ||
    /\bdisplay\s*:\s*none\b/i.test(style) ||
    /\bvisibility\s*:\s*hidden\b/i.test(style)
  );
}

function isInteractiveComponent(
  element: Element,
  role: string | null
): boolean {
  if (role && INTERACTIVE_CONTENT_ROLES.has(role)) return true;

  const dataState = element.getAttribute('data-state');
  if (dataState === 'inactive' || dataState === 'closed') return true;

  const dataOrientation = element.getAttribute('data-orientation');
  if (dataOrientation === 'horizontal' || dataOrientation === 'vertical')
    return true;

  if (element.getAttribute('data-accordion-item') !== null) return true;
  if (element.getAttribute('data-radix-collection-item') !== null) return true;

  return false;
}

function readElementMetadata(element: Element): ElementMetadata {
  const tagName = element.tagName.toLowerCase();
  const className = getAttr(element, 'class');
  const id = getAttr(element, 'id');
  const role = element.getAttribute('role');
  const isInteractive = isInteractiveComponent(element, role);
  const isHidden = isElementHidden(element);

  return { tagName, className, id, role, isHidden, isInteractive };
}

function isElementNode(value: unknown): value is Element {
  if (!isObject(value)) return false;
  const { nodeType, tagName } = value as {
    nodeType?: unknown;
    tagName?: unknown;
  };
  return nodeType === 1 && typeof tagName === 'string';
}

function getParentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const { parentNode } = element;
  return isElementNode(parentNode) ? parentNode : null;
}

function isWithinPrimaryContent(element: Element): boolean {
  let current: Element | null = element;

  while (current) {
    const tagName = current.tagName.toLowerCase();
    if (tagName === 'article' || tagName === 'main') return true;

    const role = current.getAttribute('role');
    if (role === 'main') return true;

    current = getParentElement(current);
  }

  return false;
}

function hasNoiseRole(role: string | null): boolean {
  return role !== null && NAVIGATION_ROLES.has(role);
}

function isHeaderBoilerplate(meta: ElementMetadata): boolean {
  if (meta.tagName !== 'header') return false;
  if (hasNoiseRole(meta.role)) return true;

  const combined = `${meta.className} ${meta.id}`.toLowerCase();
  return HEADER_NOISE_PATTERN.test(combined);
}

function matchesFixedOrHighZIsolate(className: string): boolean {
  if (FIXED_PATTERN.test(className)) return true;
  return HIGH_Z_PATTERN.test(className) && ISOLATE_PATTERN.test(className);
}

function isRoleNoise(meta: ElementMetadata): boolean {
  const isComplementaryAside =
    meta.tagName === 'aside' && meta.role === 'complementary';
  return !isComplementaryAside && hasNoiseRole(meta.role);
}

function scoreNavFooter(
  meta: ElementMetadata,
  structuralWeight: number
): number {
  let score = 0;
  if (ALWAYS_NOISE_TAGS.has(meta.tagName)) score += structuralWeight;
  if (isHeaderBoilerplate(meta)) score += structuralWeight;
  if (isRoleNoise(meta)) score += structuralWeight;
  return score;
}

function scorePromo(
  element: Element,
  meta: ElementMetadata,
  context: NoiseContext
): number {
  if (!context.promoEnabled) return 0;
  const promoMatch = matchPromoTokens(
    context.promoMatchers,
    meta.className,
    meta.id
  );
  if (!promoMatch.matched) return 0;
  if (promoMatch.aggressive && isWithinPrimaryContent(element)) return 0;
  return context.weights.promo;
}

function calculateNoiseScore(
  element: Element,
  meta: ElementMetadata,
  context: NoiseContext
): number {
  let score = 0;

  if (context.structuralTags.has(meta.tagName) && !meta.isInteractive) {
    score += context.weights.structural;
  }

  if (context.flags.navFooter) {
    score += scoreNavFooter(meta, context.weights.structural);
  }

  if (meta.isHidden && !meta.isInteractive) {
    score += context.weights.hidden;
  }

  if (matchesFixedOrHighZIsolate(meta.className)) {
    score += context.weights.stickyFixed;
  }

  score += scorePromo(element, meta, context);

  return score;
}

function isNoiseElement(element: Element, context: NoiseContext): boolean {
  const meta = readElementMetadata(element);
  const score = calculateNoiseScore(element, meta, context);
  return score >= context.weights.threshold;
}

function shouldPreserveDialog(element: Element): boolean {
  const role = element.getAttribute('role');
  if (role !== 'dialog' && role !== 'alertdialog') return false;

  if (isWithinPrimaryContent(element)) return true;

  const textContent = element.textContent || '';
  if (textContent.length > DIALOG_MIN_CHARS_FOR_PRESERVATION) return true;

  return element.querySelector('h1, h2, h3, h4, h5, h6') !== null;
}

function shouldPreserveNavFooter(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName !== 'nav' && tagName !== 'footer') return false;

  if (element.querySelector('article, main, section') !== null) return true;
  if (element.querySelector('[role="main"]') !== null) return true;

  const textContent = element.textContent || '';
  return textContent.trim().length >= MIN_BODY_CONTENT_LENGTH;
}

function shouldPreserveElement(element: Element): boolean {
  return shouldPreserveDialog(element) || shouldPreserveNavFooter(element);
}

function buildBaseNoiseSelector(flags: CategoryFlags): string {
  const selectors: string[] = [...BASE_NOISE_SELECTORS.hidden];

  if (flags.navFooter) {
    selectors.push(...BASE_NOISE_SELECTORS.navFooter);
  }

  if (flags.cookieBanners) {
    selectors.push(...BASE_NOISE_SELECTORS.cookieBanners);
  }

  return selectors.join(',');
}

function buildCandidateNoiseSelector(
  structuralTags: ReadonlySet<string>
): string {
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

function removeBaseAndExtraNoiseNodes(
  document: Document,
  context: NoiseContext
): void {
  const baseSelector = buildBaseNoiseSelector(context.flags);
  const combinedSelector =
    context.extraSelectors.length === 0
      ? baseSelector
      : `${baseSelector},${context.extraSelectors.join(',')}`;
  const shouldRemove = (node: Element): boolean => !shouldPreserveElement(node);

  const combinedNodes = safeQuerySelectorAll(document, combinedSelector);
  if (combinedNodes) {
    removeMatchingNodes(combinedNodes, shouldRemove);
    return;
  }

  const baseNodes = safeQuerySelectorAll(document, baseSelector);
  if (baseNodes) removeMatchingNodes(baseNodes, shouldRemove);

  for (const selector of context.extraSelectors) {
    const nodes = safeQuerySelectorAll(document, selector);
    if (nodes) removeMatchingNodes(nodes, shouldRemove);
  }
}

function removeCandidateNoiseNodes(
  document: Document,
  context: NoiseContext
): void {
  const candidateSelector = buildCandidateNoiseSelector(context.structuralTags);
  const nodes = safeQuerySelectorAll(document, candidateSelector);
  if (!nodes) return;

  removeMatchingNodes(nodes, (node) => {
    if (shouldPreserveElement(node)) return false;
    return isNoiseElement(node, context);
  });
}

function stripNoise(document: Document, context: NoiseContext): void {
  removeBaseAndExtraNoiseNodes(document, context);
  removeCandidateNoiseNodes(document, context);
}

function shouldSkipUrlResolution(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return SKIP_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function tryResolveUrl(relativeUrl: string, baseUrl: URL): string | null {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return null;
  }
}

function resolveUrlAttribute(
  element: Element,
  attr: 'href' | 'src',
  base: URL,
  shouldSkip: boolean
): void {
  const value = element.getAttribute(attr);
  if (!value) return;
  if (shouldSkip && shouldSkipUrlResolution(value)) return;

  const resolved = tryResolveUrl(value, base);
  if (resolved) element.setAttribute(attr, resolved);
}

function resolveSrcset(element: Element, base: URL): void {
  const srcset = element.getAttribute('srcset');
  if (!srcset) return;

  const resolved = srcset
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      if (!url) return entry.trim();

      const resolvedUrl = tryResolveUrl(url, base);
      if (resolvedUrl) parts[0] = resolvedUrl;

      return parts.join(' ');
    })
    .join(', ');

  element.setAttribute('srcset', resolved);
}

function resolveRelativeUrls(document: Document, baseUrl: string): void {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }

  for (const element of document.querySelectorAll(
    'a[href], img[src], source[srcset]'
  )) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') resolveUrlAttribute(element, 'href', base, true);
    else if (tag === 'img') resolveUrlAttribute(element, 'src', base, true);
    else if (tag === 'source') resolveSrcset(element, base);
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const prop = readProperty(value, key);
  return typeof prop === 'string' ? prop : undefined;
}

function readFunctionProperty(
  value: unknown,
  key: string
): (() => string) | undefined {
  const prop = readProperty(value, key);
  if (typeof prop !== 'function') return undefined;
  return prop as () => string;
}

function getBodyInnerHtml(document: unknown): string | undefined {
  const body = readProperty(document, 'body');
  return readStringProperty(body, 'innerHTML');
}

function getDocumentToString(document: unknown): (() => string) | undefined {
  const fn = readFunctionProperty(document, 'toString');
  if (!fn) return undefined;
  return fn.bind(document) as () => string;
}

function getDocumentElementOuterHtml(document: unknown): string | undefined {
  const docEl = readProperty(document, 'documentElement');
  return readStringProperty(docEl, 'outerHTML');
}

function serializeDocument(document: unknown, fallbackHtml: string): string {
  const bodyInner = getBodyInnerHtml(document);
  if (bodyInner && bodyInner.trim().length > MIN_BODY_CONTENT_LENGTH)
    return bodyInner;

  const toStringFn = getDocumentToString(document);
  if (toStringFn) return toStringFn();

  const outer = getDocumentElementOuterHtml(document);
  if (outer) return outer;

  return fallbackHtml;
}

function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}

function mayContainNoise(html: string): boolean {
  if (html.length <= NOISE_SCAN_LIMIT) {
    return (
      NOISE_TAGS_PATTERN.test(html) ||
      NOISE_ROLES_PATTERN.test(html) ||
      NOISE_OTHER_ATTRS_PATTERN.test(html) ||
      NOISE_CLASSES_PATTERN.test(html)
    );
  }

  const headSample = html.substring(0, NOISE_SCAN_LIMIT);
  const tailSample = html.substring(html.length - NOISE_SCAN_LIMIT);
  const combinedSample = `${headSample}\n${tailSample}`;
  return (
    NOISE_TAGS_PATTERN.test(combinedSample) ||
    NOISE_ROLES_PATTERN.test(combinedSample) ||
    NOISE_OTHER_ATTRS_PATTERN.test(combinedSample) ||
    NOISE_CLASSES_PATTERN.test(combinedSample)
  );
}

export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string
): string {
  const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
  if (!shouldParse) return html;

  try {
    const context = createNoiseContext(config.noiseRemoval);

    if (config.noiseRemoval.debug) {
      logDebug('Noise removal audit enabled', {
        categories: [...context.enabledCategories],
      });
    }

    const resolvedDocument = document ?? parseHTML(html).document;

    stripNoise(resolvedDocument, context);

    if (baseUrl) resolveRelativeUrls(resolvedDocument, baseUrl);

    return serializeDocument(resolvedDocument, html);
  } catch {
    return html;
  }
}
