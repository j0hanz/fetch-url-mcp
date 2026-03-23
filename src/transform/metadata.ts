import { parseHTML } from 'linkedom';

import { config } from '../lib/core.js';
import { parseUrlOrNull } from '../lib/utils.js';

import type { ExtractedMetadata, MetadataBlock } from './types.js';

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

export function normalizeDocumentTitle(
  title: string,
  baseUrl?: string
): string {
  if (!baseUrl || !title.startsWith('GitHub - ')) return title;

  const parsed = parseUrlOrNull(baseUrl);
  if (!parsed) return title;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return title;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return title;

  const [owner, repo] = segments;
  if (!owner || !repo) return title;

  return `${owner}/${repo}`;
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

  const resolved = parseUrlOrNull(trimmed, baseUrl);
  if (!resolved) {
    return undefined;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return undefined;
  }

  return resolved.toString();
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
  if (metadata.title) {
    metadata.title = normalizeDocumentTitle(metadata.title, baseUrl);
  }
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
    'favicon',
    'publishedAt',
    'modifiedAt',
  ] as const;
  for (const key of keys) {
    const value = late[key] ?? early[key];
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

const BODY_SCAN_LIMIT = 500;
const HTML_TAG_DENSITY_LIMIT = 5;

const HEADING_MARKER = /^#{1,6}\s/m;
const HEADING_STRICT = /^#{1,6}\s+/m;
const SOURCE_KEY = /^source:\s/im;
const HTML_DOC_START = /^(<!doctype|<html)/i;
const LIST_MARKER = /^(?:[-*+])\s/m;

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

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
      if (HEADING_STRICT.test(trimmed)) {
        return trimmed.replace(HEADING_MARKER, '').trim() || undefined;
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
    if (SOURCE_KEY.test(content)) return content;
    const lineEnding = getLineEnding(content);
    const firstH1Match = HEADING_MARKER.exec(content);

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
  if (SOURCE_KEY.test(fmBody)) return content;

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
  if (HTML_DOC_START.test(trimmed)) return false;

  if (parseFrontmatter(trimmed) !== null) return true;

  const tagCount = countCommonTags(content, HTML_TAG_DENSITY_LIMIT);
  if (tagCount > HTML_TAG_DENSITY_LIMIT) return false;

  return (
    HEADING_MARKER.test(content) ||
    LIST_MARKER.test(content) ||
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
