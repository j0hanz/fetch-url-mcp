import type { MetadataBlock } from '../transform/types.js';
import { config } from './core.js';

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
