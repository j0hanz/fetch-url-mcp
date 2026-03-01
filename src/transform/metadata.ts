import { parseHTML } from 'linkedom';

import type { ExtractedMetadata } from './types.js';

// ---------------------------------------------------------------------------
// Head-section parsing
// ---------------------------------------------------------------------------

const HEAD_END_PATTERN = /<\/head\s*>|<body\b/i;
const MAX_HEAD_SCAN_LENGTH = 50_000;

function extractHeadSection(html: string): string | null {
  if (html.length <= MAX_HEAD_SCAN_LENGTH) {
    const match = HEAD_END_PATTERN.exec(html);
    return match ? html.substring(0, match.index) : null;
  }

  const searchText = html.substring(0, MAX_HEAD_SCAN_LENGTH);

  const match = HEAD_END_PATTERN.exec(searchText);
  if (!match) return null;

  return html.substring(0, match.index);
}

// ---------------------------------------------------------------------------
// MetaContext & handlers
// ---------------------------------------------------------------------------

interface MetaContext {
  title: { og?: string; twitter?: string; standard?: string };
  description: { og?: string; twitter?: string; standard?: string };
  author?: string;
  image?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

const META_PROPERTY_HANDLERS = new Map<
  string,
  (ctx: MetaContext, content: string) => void
>([
  [
    'og:title',
    (ctx, c) => {
      ctx.title.og = c;
    },
  ],
  [
    'og:description',
    (ctx, c) => {
      ctx.description.og = c;
    },
  ],
  [
    'og:image',
    (ctx, c) => {
      ctx.image = c;
    },
  ],
  [
    'article:published_time',
    (ctx, c) => {
      ctx.publishedAt = c;
    },
  ],
  [
    'article:modified_time',
    (ctx, c) => {
      ctx.modifiedAt = c;
    },
  ],
]);

const META_NAME_HANDLERS = new Map<
  string,
  (ctx: MetaContext, content: string) => void
>([
  [
    'twitter:title',
    (ctx, c) => {
      ctx.title.twitter = c;
    },
  ],
  [
    'twitter:description',
    (ctx, c) => {
      ctx.description.twitter = c;
    },
  ],
  [
    'description',
    (ctx, c) => {
      ctx.description.standard = c;
    },
  ],
  [
    'author',
    (ctx, c) => {
      ctx.author = c;
    },
  ],
]);

function processMetaTag(ctx: MetaContext, tag: Element): void {
  const content = tag.getAttribute('content')?.trim();
  if (!content) return;

  const property = tag.getAttribute('property');
  if (property) META_PROPERTY_HANDLERS.get(property)?.(ctx, content);

  const name = tag.getAttribute('name');
  if (name) META_NAME_HANDLERS.get(name)?.(ctx, content);
}

function buildMetaContext(document: Document): MetaContext {
  const ctx: MetaContext = { title: {}, description: {} };

  for (const tag of document.querySelectorAll('meta')) {
    processMetaTag(ctx, tag);
  }

  const titleEl = document.querySelector('title');
  if (!ctx.title.standard && titleEl?.textContent) {
    ctx.title.standard = titleEl.textContent.trim();
  }

  return ctx;
}

function resolveMetadataFromContext(ctx: MetaContext): ExtractedMetadata {
  const metadata: ExtractedMetadata = {};

  const resolvedTitle = ctx.title.og ?? ctx.title.twitter ?? ctx.title.standard;
  const resolvedDesc =
    ctx.description.og ?? ctx.description.twitter ?? ctx.description.standard;

  if (resolvedTitle) metadata.title = resolvedTitle;
  if (resolvedDesc) metadata.description = resolvedDesc;
  if (ctx.author) metadata.author = ctx.author;
  if (ctx.image) metadata.image = ctx.image;
  if (ctx.publishedAt) metadata.publishedAt = ctx.publishedAt;
  if (ctx.modifiedAt) metadata.modifiedAt = ctx.modifiedAt;

  return metadata;
}

// ---------------------------------------------------------------------------
// Favicon resolution
// ---------------------------------------------------------------------------

function resolveFaviconUrl(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase().startsWith('data:')) return undefined;

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function extractMetadata(
  document: Document,
  baseUrl?: string
): ExtractedMetadata {
  const ctx = buildMetaContext(document);
  const metadata = resolveMetadataFromContext(ctx);
  if (baseUrl) {
    const icon32 = document.querySelector<HTMLLinkElement>(
      'link[rel="icon"][sizes="32x32"]'
    );
    const href = icon32?.getAttribute('href');
    if (href) {
      const resolved = resolveFaviconUrl(href, baseUrl);
      if (resolved) metadata.favicon = resolved;
    }
  }

  return metadata;
}

export function extractMetadataFromHead(
  html: string,
  baseUrl?: string
): ExtractedMetadata | null {
  const headSection = extractHeadSection(html);
  if (!headSection) return null;

  try {
    const { document } = parseHTML(
      `<!DOCTYPE html><html>${headSection}</head><body></body></html>`
    );
    return extractMetadata(document, baseUrl);
  } catch {
    return null;
  }
}

export function mergeMetadata(
  early: ExtractedMetadata | null,
  late: ExtractedMetadata
): ExtractedMetadata {
  if (!early) return late;

  const merged: ExtractedMetadata = {};
  const keys = [
    'title',
    'description',
    'author',
    'image',
    'publishedAt',
    'modifiedAt',
  ] as const;
  for (const key of keys) {
    const value = late[key] ?? early[key];
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}
