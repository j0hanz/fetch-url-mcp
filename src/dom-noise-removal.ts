import { parseHTML } from 'linkedom';

import { config } from './config.js';
import { isObject } from './type-guards.js';

function isElement(node: unknown): node is HTMLElement {
  return (
    isObject(node) &&
    'getAttribute' in node &&
    typeof (node as { getAttribute?: unknown }).getAttribute === 'function'
  );
}

function isNodeListLike(
  value: unknown
): value is
  | ArrayLike<Element>
  | { length: number; item: (index: number) => Element | null } {
  return (
    isObject(value) &&
    typeof (value as { length?: unknown }).length === 'number'
  );
}

function getNodeListItem(
  nodes:
    | ArrayLike<Element>
    | { length: number; item: (index: number) => Element | null },
  index: number
): Element | null {
  if ('item' in nodes && typeof nodes.item === 'function') {
    return nodes.item(index);
  }
  return (nodes as ArrayLike<Element>)[index] ?? null;
}

function removeNodeFromDom(
  node: Element,
  shouldRemove: (node: Element) => boolean,
  auditCallback?: (node: Element, reason: string) => void
): void {
  if (!shouldRemove(node)) return;
  if (auditCallback) auditCallback(node, 'noise-filter');
  node.remove();
}

// Remove matching nodes (iterate backwards for NodeList-like collections).
function removeNodes(
  nodes: NodeListOf<Element> | Iterable<Element>,
  shouldRemove: (node: Element) => boolean,
  auditCallback?: (node: Element, reason: string) => void
): void {
  if (isNodeListLike(nodes)) {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = getNodeListItem(nodes, i);
      if (node) removeNodeFromDom(node, shouldRemove, auditCallback);
    }
    return;
  }

  for (const node of nodes) {
    removeNodeFromDom(node, shouldRemove, auditCallback);
  }
}

const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;

function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}

const NOISE_SCAN_LIMIT = 50_000;

const NOISE_MARKERS = [
  '<script',
  '<style',
  '<noscript',
  '<iframe',
  '<nav',
  '<footer',
  '<header',
  '<form',
  '<button',
  '<input',
  '<select',
  '<textarea',
  '<svg',
  '<canvas',
  ' aria-hidden="true"',
  " aria-hidden='true'",
  ' hidden',
  ' role="navigation"',
  " role='navigation'",
  ' role="banner"',
  " role='banner'",
  ' role="complementary"',
  " role='complementary'",
  ' role="contentinfo"',
  " role='contentinfo'",
  ' role="tree"',
  " role='tree'",
  ' role="menubar"',
  " role='menubar'",
  ' role="menu"',
  " role='menu'",
  ' banner',
  ' promo',
  ' announcement',
  ' cta',
  ' advert',
  ' newsletter',
  ' subscribe',
  ' cookie',
  ' consent',
  ' popup',
  ' modal',
  ' overlay',
  ' toast',
  ' fixed',
  ' sticky',
  ' z-50',
  ' z-4',
  ' isolate',
  ' breadcrumb',
  ' pagination',
] as const;

function mayContainNoise(html: string): boolean {
  const sample =
    html.length > NOISE_SCAN_LIMIT ? html.slice(0, NOISE_SCAN_LIMIT) : html;
  const haystack = sample.toLowerCase();
  return NOISE_MARKERS.some((marker) => haystack.includes(marker));
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

function buildNoiseSelector(extraSelectors: readonly string[]): string {
  const extra = extraSelectors.filter((s) => s.trim().length > 0);
  return extra.length === 0
    ? BASE_NOISE_SELECTOR
    : `${BASE_NOISE_SELECTOR},${extra.join(',')}`;
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

    const tokens = [...this.getTokens()];
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
}>;

// Weighted heuristic: higher score => more likely boilerplate UI.
const NOISE_WEIGHTS = {
  HIDDEN: 50,
  STRUCTURAL: 50,
  PROMO: 35,
  STICKY_FIXED: 30,
  THRESHOLD: 50,
} as const;

class NoiseClassifier {
  constructor(private readonly promo: PromoDetector) {}

  isNoise(element: HTMLElement): boolean {
    const score = this.calculateNoiseScore(element);
    return score >= NOISE_WEIGHTS.THRESHOLD;
  }

  private calculateNoiseScore(element: HTMLElement): number {
    const meta = this.readMetadata(element);
    let score = 0;

    if (this.isStructuralNoise(meta, element)) {
      score += NOISE_WEIGHTS.STRUCTURAL;
    }
    if (ALWAYS_NOISE_TAGS.has(meta.tagName)) {
      score += NOISE_WEIGHTS.STRUCTURAL;
    }
    if (this.isHeaderBoilerplate(meta)) {
      score += NOISE_WEIGHTS.STRUCTURAL;
    }

    if (this.isHiddenNoise(meta, element)) {
      score += NOISE_WEIGHTS.HIDDEN;
    }

    if (this.isRoleNoise(meta)) {
      score += NOISE_WEIGHTS.STRUCTURAL;
    }

    if (this.matchesFixedOrHighZIsolate(meta.className)) {
      score += NOISE_WEIGHTS.STICKY_FIXED;
    }

    if (this.promo.matches(meta.className, meta.id)) {
      score += NOISE_WEIGHTS.PROMO;
    }

    return score;
  }

  private readMetadata(element: HTMLElement): ElementMetadata {
    return {
      tagName: element.tagName.toLowerCase(),
      className: element.getAttribute('class') ?? '',
      id: element.getAttribute('id') ?? '',
      role: element.getAttribute('role'),
      isHidden: this.isHidden(element),
    };
  }

  private isStructuralNoise(
    meta: ElementMetadata,
    element: HTMLElement
  ): boolean {
    if (!STRUCTURAL_TAGS.has(meta.tagName)) return false;
    return !this.isInteractiveComponent(element);
  }

  private isHeaderBoilerplate(meta: ElementMetadata): boolean {
    if (meta.tagName !== 'header') return false;
    if (this.hasNoiseRole(meta.role)) return true;

    const combined = `${meta.className} ${meta.id}`.toLowerCase();
    return HEADER_NOISE_PATTERN.test(combined);
  }

  private isHiddenNoise(meta: ElementMetadata, element: HTMLElement): boolean {
    if (!meta.isHidden) return false;
    // Keep hidden interactive components (often framework-managed).
    return !this.isInteractiveComponent(element);
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

  private isHidden(element: HTMLElement): boolean {
    const style = element.getAttribute('style') ?? '';
    return (
      element.getAttribute('hidden') !== null ||
      element.getAttribute('aria-hidden') === 'true' ||
      /\bdisplay\s*:\s*none\b/i.test(style) ||
      /\bvisibility\s*:\s*hidden\b/i.test(style)
    );
  }

  private isInteractiveComponent(element: HTMLElement): boolean {
    const role = element.getAttribute('role');
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
    this.removeBySelector(
      document,
      buildNoiseSelector(config.noiseRemoval.extraSelectors),
      false
    );
    this.removeBySelector(document, CANDIDATE_NOISE_SELECTOR, true);
  }

  private removeBySelector(
    document: Document,
    selector: string,
    checkNoise: boolean
  ): void {
    const nodes = document.querySelectorAll(selector);
    removeNodes(nodes, (node) => {
      if (!isElement(node)) return false;
      return checkNoise ? this.classifier.isNoise(node) : true;
    });
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
      // Invalid base URL -> skip.
      return;
    }

    for (const element of document.querySelectorAll(
      'a[href], img[src], source[srcset]'
    )) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') this.resolveAnchor(element, base);
      else if (tag === 'img') this.resolveImage(element, base);
      else if (tag === 'source') this.resolveSource(element, base);
    }
  }

  private resolveAnchor(element: Element, base: URL): void {
    const href = element.getAttribute('href');
    if (!href || shouldSkipUrlResolution(href)) return;

    const resolved = tryResolveUrl(href, base);
    if (resolved) element.setAttribute('href', resolved);
  }

  private resolveImage(element: Element, base: URL): void {
    const src = element.getAttribute('src');
    if (!src || shouldSkipUrlResolution(src)) return;

    const resolved = tryResolveUrl(src, base);
    if (resolved) element.setAttribute('src', resolved);
  }

  // Resolve all srcset URLs (even if they have special prefixes).
  private resolveSource(element: Element, base: URL): void {
    const srcset = element.getAttribute('srcset');
    if (!srcset) return;

    const resolved = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const url = parts[0];
        if (url) {
          const resolvedUrl = tryResolveUrl(url, base);
          if (resolvedUrl) parts[0] = resolvedUrl;
        }
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
    if (typeof fn === 'function') return fn.bind(document) as () => string;
    return undefined;
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

    try {
      const resolvedDocument = document ?? parseHTML(html).document;

      this.stripper.strip(resolvedDocument);

      if (baseUrl) {
        this.urlResolver.resolve(resolvedDocument, baseUrl);
      }

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
