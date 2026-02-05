import { parseHTML } from 'linkedom';

import { config } from './config.js';
import { isObject } from './type-guards.js';

type NodeListLike<T> =
  | ArrayLike<T>
  | { length: number; item: (index: number) => T | null };

function isNodeListLike<T>(value: unknown): value is NodeListLike<T> {
  return (
    isObject(value) &&
    typeof (value as { length?: unknown }).length === 'number'
  );
}

function getNodeListItem<T>(nodes: NodeListLike<T>, index: number): T | null {
  if ('item' in nodes && typeof nodes.item === 'function')
    return nodes.item(index);
  return (nodes as ArrayLike<T>)[index] ?? null;
}

function removeNodes(
  nodes: NodeListOf<Element> | Iterable<Element>,
  shouldRemove: (node: Element) => boolean
): void {
  if (isNodeListLike<Element>(nodes)) {
    // Iterate backwards to be safe for live collections (even though querySelectorAll is typically static).
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = getNodeListItem(nodes, i);
      if (node && shouldRemove(node)) node.remove();
    }
    return;
  }

  for (const node of nodes) {
    if (shouldRemove(node)) node.remove();
  }
}

const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;

function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}

const NOISE_SCAN_LIMIT = 50_000;

const NOISE_TAGS =
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i;

const NOISE_ROLES =
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i;

const NOISE_OTHER_ATTRS = /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i;

const NOISE_CLASSES =
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast|fixed|sticky|z-50|z-4|isolate|breadcrumb|pagination)\b/i;

function mayContainNoise(html: string): boolean {
  const sample =
    html.length > NOISE_SCAN_LIMIT ? html.substring(0, NOISE_SCAN_LIMIT) : html;
  return (
    NOISE_TAGS.test(sample) ||
    NOISE_ROLES.test(sample) ||
    NOISE_OTHER_ATTRS.test(sample) ||
    NOISE_CLASSES.test(sample)
  );
}

const STRUCTURAL_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'svg',
  'canvas',
]);

const ALWAYS_NOISE_TAGS = new Set(['nav', 'footer']);

const BASE_NOISE_SELECTORS = [
  'nav',
  'footer',
  'header[class*="site"]',
  'header[class*="nav"]',
  'header[class*="menu"]',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="dialog"]',
  '[style*="display: none"]',
  '[style*="display:none"]',
  '[hidden]',
  '[aria-hidden="true"]',
] as const;

const BASE_NOISE_SELECTOR = BASE_NOISE_SELECTORS.join(',');

const CANDIDATE_NOISE_SELECTOR = [
  ...STRUCTURAL_TAGS,
  ...ALWAYS_NOISE_TAGS,
  'aside',
  'header',
  '[class]',
  '[id]',
  '[role]',
  '[style]',
].join(',');

function normalizeSelectors(selectors: readonly string[]): string[] {
  return selectors.map((s) => s.trim()).filter((s) => s.length > 0);
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

const BASE_PROMO_TOKENS = [
  'banner',
  'promo',
  'announcement',
  'cta',
  'advert',
  'ad',
  'ads',
  'sponsor',
  'newsletter',
  'subscribe',
  'cookie',
  'consent',
  'popup',
  'modal',
  'overlay',
  'toast',
  'share',
  'social',
  'related',
  'recommend',
  'comment',
  'breadcrumb',
  'pagination',
  'pager',
  'taglist',
] as const;

const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_PATTERN = /\b(fixed|sticky)\b/;
const HIGH_Z_PATTERN = /\bz-(?:4\d|50)\b/;
const ISOLATE_PATTERN = /\bisolate\b/;

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class PromoDetector {
  private tokenCache: Set<string> | null = null;
  private regexCache: RegExp | null = null;

  matches(className: string, id: string): boolean {
    const regex = this.getRegex();
    return regex.test(className) || regex.test(id);
  }

  private getTokens(): Set<string> {
    if (this.tokenCache) return this.tokenCache;

    const tokens = new Set<string>(BASE_PROMO_TOKENS);
    for (const token of config.noiseRemoval.extraTokens) {
      const normalized = token.toLowerCase().trim();
      if (normalized) tokens.add(normalized);
    }

    this.tokenCache = tokens;
    return tokens;
  }

  private getRegex(): RegExp {
    if (this.regexCache) return this.regexCache;

    const escaped = [...this.getTokens()].map(escapeRegexLiteral);
    const pattern = `(?:^|[^a-z0-9])(?:${escaped.join('|')})(?:$|[^a-z0-9])`;

    this.regexCache = new RegExp(pattern, 'i');
    return this.regexCache;
  }
}

type ElementMetadata = Readonly<{
  tagName: string;
  className: string;
  id: string;
  role: string | null;
  isHidden: boolean;
  isInteractive: boolean;
}>;

class NoiseClassifier {
  constructor(private readonly promo: PromoDetector) {}

  isNoise(element: Element): boolean {
    return (
      this.calculateNoiseScore(element) >= config.noiseRemoval.weights.threshold
    );
  }

  private calculateNoiseScore(element: Element): number {
    const meta = this.readMetadata(element);
    const { weights } = config.noiseRemoval;
    let score = 0;

    if (this.isStructuralNoise(meta)) score += weights.structural;
    if (ALWAYS_NOISE_TAGS.has(meta.tagName)) score += weights.structural;
    if (this.isHeaderBoilerplate(meta)) score += weights.structural;

    if (this.isHiddenNoise(meta)) score += weights.hidden;
    if (this.isRoleNoise(meta)) score += weights.structural;

    if (this.matchesFixedOrHighZIsolate(meta.className))
      score += weights.stickyFixed;
    if (this.promo.matches(meta.className, meta.id)) score += weights.promo;

    return score;
  }

  private readMetadata(element: Element): ElementMetadata {
    const tagName = element.tagName.toLowerCase();
    const className = element.getAttribute('class') ?? '';
    const id = element.getAttribute('id') ?? '';
    const role = element.getAttribute('role');

    const isInteractive = this.isInteractiveComponent(element, role);
    const isHidden = this.isHidden(element);

    return { tagName, className, id, role, isHidden, isInteractive };
  }

  private isStructuralNoise(meta: ElementMetadata): boolean {
    if (!STRUCTURAL_TAGS.has(meta.tagName)) return false;
    return !meta.isInteractive;
  }

  private isHeaderBoilerplate(meta: ElementMetadata): boolean {
    if (meta.tagName !== 'header') return false;
    if (this.hasNoiseRole(meta.role)) return true;

    const combined = `${meta.className} ${meta.id}`.toLowerCase();
    return HEADER_NOISE_PATTERN.test(combined);
  }

  private isHiddenNoise(meta: ElementMetadata): boolean {
    if (!meta.isHidden) return false;
    return !meta.isInteractive;
  }

  private isRoleNoise(meta: ElementMetadata): boolean {
    const isComplementaryAside =
      meta.tagName === 'aside' && meta.role === 'complementary';
    if (isComplementaryAside) return false;

    return this.hasNoiseRole(meta.role);
  }

  private hasNoiseRole(role: string | null): boolean {
    return role !== null && NAVIGATION_ROLES.has(role);
  }

  private matchesFixedOrHighZIsolate(className: string): boolean {
    return (
      FIXED_PATTERN.test(className) ||
      (HIGH_Z_PATTERN.test(className) && ISOLATE_PATTERN.test(className))
    );
  }

  private isHidden(element: Element): boolean {
    const style = element.getAttribute('style') ?? '';
    return (
      element.getAttribute('hidden') !== null ||
      element.getAttribute('aria-hidden') === 'true' ||
      /\bdisplay\s*:\s*none\b/i.test(style) ||
      /\bvisibility\s*:\s*hidden\b/i.test(style)
    );
  }

  private isInteractiveComponent(
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
    if (element.getAttribute('data-radix-collection-item') !== null)
      return true;

    return false;
  }
}

class NoiseStripper {
  constructor(private readonly classifier: NoiseClassifier) {}

  strip(document: Document): void {
    this.removeBaseAndExtras(document);
    this.removeCandidates(document);
  }

  private removeBaseAndExtras(document: Document): void {
    const extra = normalizeSelectors(config.noiseRemoval.extraSelectors);
    const combined =
      extra.length === 0
        ? BASE_NOISE_SELECTOR
        : `${BASE_NOISE_SELECTOR},${extra.join(',')}`;

    // Fast path: same behavior as before when selectors are valid.
    const combinedNodes = safeQuerySelectorAll(document, combined);
    if (combinedNodes) {
      removeNodes(combinedNodes, () => true);
      return;
    }

    // Robust fallback: one invalid extra selector should not disable base stripping.
    const baseNodes = safeQuerySelectorAll(document, BASE_NOISE_SELECTOR);
    if (baseNodes) removeNodes(baseNodes, () => true);

    for (const selector of extra) {
      const nodes = safeQuerySelectorAll(document, selector);
      if (nodes) removeNodes(nodes, () => true);
    }
  }

  private removeCandidates(document: Document): void {
    const nodes = safeQuerySelectorAll(document, CANDIDATE_NOISE_SELECTOR);
    if (!nodes) return;

    removeNodes(nodes, (node) => this.classifier.isNoise(node));
  }
}

const SKIP_URL_PREFIXES = [
  '#',
  'java' + 'script:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
] as const;

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

class RelativeUrlResolver {
  resolve(document: Document, baseUrl: string): void {
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
      if (tag === 'a') this.resolveUrlAttr(element, 'href', base, true);
      else if (tag === 'img') this.resolveUrlAttr(element, 'src', base, true);
      else if (tag === 'source') this.resolveSrcset(element, base);
    }
  }

  private resolveUrlAttr(
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

  private resolveSrcset(element: Element, base: URL): void {
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
}

class DocumentSerializer {
  // Prefer substantial body HTML; otherwise fall back to document serialization or original input.
  serialize(document: unknown, fallbackHtml: string): string {
    const bodyInner = this.getBodyInnerHtml(document);
    if (bodyInner && bodyInner.trim().length > 100) return bodyInner;

    const toStringFn = this.getDocumentToString(document);
    if (toStringFn) return toStringFn();

    const outer = this.getDocumentElementOuterHtml(document);
    if (outer) return outer;

    return fallbackHtml;
  }

  private getBodyInnerHtml(document: unknown): string | undefined {
    if (!isObject(document)) return undefined;
    const { body } = document as { body?: unknown };
    if (
      isObject(body) &&
      typeof (body as { innerHTML?: unknown }).innerHTML === 'string'
    ) {
      return (body as { innerHTML: string }).innerHTML;
    }
    return undefined;
  }

  private getDocumentToString(document: unknown): (() => string) | undefined {
    if (!isObject(document)) return undefined;
    const fn = (document as { toString?: unknown }).toString;
    if (typeof fn !== 'function') return undefined;
    return fn.bind(document) as () => string;
  }

  private getDocumentElementOuterHtml(document: unknown): string | undefined {
    if (!isObject(document)) return undefined;
    const docEl = (document as { documentElement?: unknown }).documentElement;
    if (
      isObject(docEl) &&
      typeof (docEl as { outerHTML?: unknown }).outerHTML === 'string'
    ) {
      return (docEl as { outerHTML: string }).outerHTML;
    }
    return undefined;
  }
}

class HtmlNoiseRemovalPipeline {
  private readonly promo = new PromoDetector();
  private readonly classifier = new NoiseClassifier(this.promo);
  private readonly stripper = new NoiseStripper(this.classifier);
  private readonly urlResolver = new RelativeUrlResolver();
  private readonly serializer = new DocumentSerializer();

  removeNoise(html: string, document?: Document, baseUrl?: string): string {
    const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
    if (!shouldParse) return html;

    // Best-effort: keep the original behavior of never throwing.
    try {
      const resolvedDocument = document ?? parseHTML(html).document;

      this.stripper.strip(resolvedDocument);

      if (baseUrl) this.urlResolver.resolve(resolvedDocument, baseUrl);

      return this.serializer.serialize(resolvedDocument, html);
    } catch {
      return html;
    }
  }
}

const pipeline = new HtmlNoiseRemovalPipeline();

export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string
): string {
  return pipeline.removeNoise(html, document, baseUrl);
}
