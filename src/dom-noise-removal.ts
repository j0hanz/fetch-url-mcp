/**
 * DOM noise removal utilities for cleaning HTML before markdown conversion.
 * Removes navigation, ads, popups, and other non-content elements.
 */
import { parseHTML } from 'linkedom';

import { config } from './config.js';
import { isRecord } from './type-guards.js';

// ─────────────────────────────────────────────────────────────────────────────
// DOM Type Guards and Accessors
// ─────────────────────────────────────────────────────────────────────────────

function isElement(node: unknown): node is HTMLElement {
  return (
    isRecord(node) &&
    'getAttribute' in node &&
    typeof node.getAttribute === 'function'
  );
}

function getBodyInnerHtml(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const { body } = document;
  if (isRecord(body) && typeof body.innerHTML === 'string') {
    return body.innerHTML;
  }
  return undefined;
}

function getDocumentToString(document: unknown): (() => string) | undefined {
  if (!isRecord(document)) return undefined;
  if (typeof document.toString === 'function') {
    return document.toString.bind(document) as () => string;
  }
  return undefined;
}

function getDocumentElementOuterHtml(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const docEl = document.documentElement;
  if (isRecord(docEl) && typeof docEl.outerHTML === 'string') {
    return docEl.outerHTML;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Noise Detection Constants
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Get promo tokens merged with any user-configured extra tokens.
 * Memoized because it is used in hot paths when scanning many nodes.
 */
let promoTokensCache: Set<string> | null = null;

function getPromoTokens(): Set<string> {
  if (promoTokensCache) return promoTokensCache;

  const tokens = new Set<string>(BASE_PROMO_TOKENS);
  for (const token of config.noiseRemoval.extraTokens) {
    const normalized = token.toLowerCase().trim();
    if (normalized) tokens.add(normalized);
  }

  promoTokensCache = tokens;
  return tokens;
}

const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_PATTERN = /\b(fixed|sticky)\b/;
const HIGH_Z_PATTERN = /\bz-(?:4\d|50)\b/;
const ISOLATE_PATTERN = /\bisolate\b/;

const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
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
];

// ─────────────────────────────────────────────────────────────────────────────
// Noise Detection Functions
// ─────────────────────────────────────────────────────────────────────────────

const NOISE_SCAN_LIMIT = 50_000;

function mayContainNoise(html: string): boolean {
  // Fast path: only scan a bounded prefix; parsing is the expensive step anyway.
  // Most noise markers appear near the top of the document (nav, scripts, meta, etc.).
  const sample =
    html.length > NOISE_SCAN_LIMIT ? html.slice(0, NOISE_SCAN_LIMIT) : html;
  const haystack = sample.toLowerCase();
  return NOISE_MARKERS.some((marker) => haystack.includes(marker));
}

function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}

function isStructuralNoiseTag(tagName: string): boolean {
  return STRUCTURAL_TAGS.has(tagName);
}

function isElementHidden(element: HTMLElement): boolean {
  const style = element.getAttribute('style') ?? '';
  return (
    element.getAttribute('hidden') !== null ||
    element.getAttribute('aria-hidden') === 'true' ||
    /\bdisplay\s*:\s*none\b/i.test(style) ||
    /\bvisibility\s*:\s*hidden\b/i.test(style)
  );
}

function hasNoiseRole(role: string | null): boolean {
  return role !== null && NAVIGATION_ROLES.has(role);
}

function tokenizeIdentifierLikeText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function matchesPromoIdOrClass(className: string, id: string): boolean {
  const tokens = tokenizeIdentifierLikeText(`${className} ${id}`);
  const promoTokens = getPromoTokens();
  return tokens.some((token) => promoTokens.has(token));
}

function matchesFixedOrHighZIsolate(className: string): boolean {
  return (
    FIXED_PATTERN.test(className) ||
    (HIGH_Z_PATTERN.test(className) && ISOLATE_PATTERN.test(className))
  );
}

interface ElementMetadata {
  tagName: string;
  className: string;
  id: string;
  role: string | null;
  isHidden: boolean;
}

function readElementMetadata(element: HTMLElement): ElementMetadata {
  return {
    tagName: element.tagName.toLowerCase(),
    className: element.getAttribute('class') ?? '',
    id: element.getAttribute('id') ?? '',
    role: element.getAttribute('role'),
    isHidden: isElementHidden(element),
  };
}

function isBoilerplateHeader({
  className,
  id,
  role,
}: ElementMetadata): boolean {
  if (hasNoiseRole(role)) return true;
  const combined = `${className} ${id}`.toLowerCase();
  return HEADER_NOISE_PATTERN.test(combined);
}

function isNoiseElement(node: HTMLElement): boolean {
  const metadata = readElementMetadata(node);
  const isComplementaryAside =
    metadata.tagName === 'aside' && metadata.role === 'complementary';
  return (
    isStructuralNoiseTag(metadata.tagName) ||
    ALWAYS_NOISE_TAGS.has(metadata.tagName) ||
    (metadata.tagName === 'header' && isBoilerplateHeader(metadata)) ||
    metadata.isHidden ||
    (!isComplementaryAside && hasNoiseRole(metadata.role)) ||
    matchesFixedOrHighZIsolate(metadata.className) ||
    matchesPromoIdOrClass(metadata.className, metadata.id)
  );
}

function isNodeListLike(
  value: unknown
): value is { length: number; item?: (index: number) => Element | null } {
  return isRecord(value) && typeof value.length === 'number';
}

function tryGetNodeListItem(
  nodes: { length: number; item?: (index: number) => Element | null },
  index: number
): Element | null {
  if (typeof nodes.item === 'function') return nodes.item(index);
  return (
    (nodes as unknown as Record<number, Element | undefined>)[index] ?? null
  );
}

function removeNoiseFromNodeListLike(
  nodes: { length: number; item?: (index: number) => Element | null },
  shouldCheckNoise: boolean
): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = tryGetNodeListItem(nodes, index);
    if (!node) continue;
    if (isElement(node) && (!shouldCheckNoise || isNoiseElement(node))) {
      node.remove();
    }
  }
}

function removeNoiseNodes(
  nodes: NodeListOf<Element> | Iterable<Element>,
  shouldCheckNoise = true
): void {
  if (isNodeListLike(nodes)) {
    removeNoiseFromNodeListLike(nodes, shouldCheckNoise);
    return;
  }

  // Generic iterable: copy to avoid iteration issues while removing.
  const nodeList = Array.from(nodes);
  for (const node of nodeList) {
    if (isElement(node) && (!shouldCheckNoise || isNoiseElement(node))) {
      node.remove();
    }
  }
}

function stripNoiseNodes(document: Document): void {
  // Pass 1: Trusted selectors (Common noise)
  // We trust these selectors match actual noise, so we skip the expensive isNoiseElement check
  const baseSelectors = [
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
  ];

  // Add user-configured extra selectors
  const extraSelectors = config.noiseRemoval.extraSelectors.filter(
    (s) => s.trim().length > 0
  );
  const targetSelectors = [...baseSelectors, ...extraSelectors].join(',');

  if (targetSelectors) {
    const potentialNoiseNodes = document.querySelectorAll(targetSelectors);
    removeNoiseNodes(potentialNoiseNodes, false);
  }

  // Second pass: check remaining elements for noise patterns (promo, fixed positioning, etc.)
  const candidateSelectors = [
    ...STRUCTURAL_TAGS,
    ...ALWAYS_NOISE_TAGS,
    'aside',
    'header',
    '[class]',
    '[id]',
    '[role]',
    '[style]',
  ].join(',');
  const allElements = document.querySelectorAll(candidateSelectors);
  removeNoiseNodes(allElements, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Resolution
// ─────────────────────────────────────────────────────────────────────────────

// Protocol patterns to skip during URL resolution (fragment, mailto, tel, blob, data, javascript)
// JavaScript protocol is detected to skip it for XSS prevention, not to evaluate it
const SKIP_URL_PREFIXES = [
  '#',
  // eslint-disable-next-line sonarjs/code-eval -- prefix detection, not evaluation
  'javascript:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
] as const;

/**
 * Check if a URL scheme should be skipped during resolution.
 * These schemes are either fragment-only (#), protocol handlers (mailto, tel),
 * inline data (data, blob), or javascript: which we skip to avoid XSS.
 */
function shouldSkipUrlResolution(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return SKIP_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Safely resolve a relative URL to absolute using base URL.
 */
function tryResolveUrl(relativeUrl: string, baseUrl: URL): string | null {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Resolve anchor hrefs to absolute URLs.
 */
function resolveAnchorUrls(document: Document, baseUrl: URL): void {
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (href && !shouldSkipUrlResolution(href)) {
      const resolved = tryResolveUrl(href, baseUrl);
      if (resolved) anchor.setAttribute('href', resolved);
    }
  }
}

/**
 * Resolve image srcs to absolute URLs.
 */
function resolveImageUrls(document: Document, baseUrl: URL): void {
  for (const img of document.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (src && !shouldSkipUrlResolution(src)) {
      const resolved = tryResolveUrl(src, baseUrl);
      if (resolved) img.setAttribute('src', resolved);
    }
  }
}

/**
 * Resolve source srcset to absolute URLs (for picture elements).
 */
function resolveSrcsetUrls(document: Document, baseUrl: URL): void {
  for (const source of document.querySelectorAll('source[srcset]')) {
    const srcset = source.getAttribute('srcset');
    if (!srcset) continue;

    // srcset can have multiple URLs with descriptors like "url 1x, url 2x"
    const resolved = srcset
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        const url = parts[0];
        if (url) {
          const resolvedUrl = tryResolveUrl(url, baseUrl);
          if (resolvedUrl) parts[0] = resolvedUrl;
        }
        return parts.join(' ');
      })
      .join(', ');
    source.setAttribute('srcset', resolved);
  }
}

/**
 * Resolve relative URLs in anchor and image elements to absolute URLs.
 * Fixes broken links/images in markdown output when the source uses relative paths.
 */
function resolveRelativeUrls(document: Document, baseUrl: string): void {
  try {
    const base = new URL(baseUrl);
    resolveAnchorUrls(document, base);
    resolveImageUrls(document, base);
    resolveSrcsetUrls(document, base);
  } catch {
    /* invalid base URL - skip resolution */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove noise elements from HTML and resolve relative URLs.
 * Used as a preprocessing step before markdown conversion.
 */
export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string
): string {
  const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
  if (!shouldParse) return html;

  try {
    const resolvedDocument = document ?? parseHTML(html).document;

    stripNoiseNodes(resolvedDocument);

    // Resolve relative URLs before converting to markdown
    if (baseUrl) {
      resolveRelativeUrls(resolvedDocument, baseUrl);
    }

    const bodyInnerHtml = getBodyInnerHtml(resolvedDocument);
    if (bodyInnerHtml) return bodyInnerHtml;

    const docToString = getDocumentToString(resolvedDocument);
    if (docToString) return docToString();

    const documentElementOuterHtml =
      getDocumentElementOuterHtml(resolvedDocument);
    if (documentElementOuterHtml) return documentElementOuterHtml;

    return html;
  } catch {
    return html;
  }
}
