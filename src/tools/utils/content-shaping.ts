import { TRUNCATION_MARKER } from '../../config/formatting.js';
import type {
  ExtractedArticle,
  ExtractedMetadata,
  MetadataBlock,
} from '../../config/types/content.js';
import type { TruncationResult } from '../../config/types/runtime.js';

import { sanitizeText } from '../../utils/sanitizer.js';

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;

export function determineContentExtractionSource(
  extractMainContent: boolean,
  article: ExtractedArticle | null
): article is ExtractedArticle {
  return extractMainContent && !!article;
}

export function createContentMetadataBlock(
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  shouldExtractFromArticle: boolean,
  includeMetadata: boolean
): MetadataBlock | undefined {
  if (!includeMetadata) return undefined;
  const now = new Date().toISOString();
  const metadata: MetadataBlock = {
    type: 'metadata',
    url,
    fetchedAt: now,
  };

  if (shouldExtractFromArticle && article) {
    if (article.title !== undefined) metadata.title = article.title;
    if (article.byline !== undefined) metadata.author = article.byline;
    return metadata;
  }

  if (extractedMeta.title !== undefined) metadata.title = extractedMeta.title;
  if (extractedMeta.description !== undefined) {
    metadata.description = extractedMeta.description;
  }
  if (extractedMeta.author !== undefined) {
    metadata.author = extractedMeta.author;
  }

  return metadata;
}

export function truncateContent(
  content: string,
  maxLength?: number,
  suffix = TRUNCATION_MARKER
): TruncationResult {
  if (
    maxLength === undefined ||
    maxLength <= 0 ||
    content.length <= maxLength
  ) {
    return { content, truncated: false };
  }

  const safeMax = Math.max(0, maxLength - suffix.length);
  const marker =
    suffix.length > maxLength ? suffix.substring(0, maxLength) : suffix;

  return {
    content: `${content.substring(0, safeMax)}${marker}`,
    truncated: true,
  };
}

export function extractTitleFromHtml(html: string): string | undefined {
  const match = TITLE_PATTERN.exec(html);
  if (!match?.[1]) return undefined;
  const decoded = decodeHtmlEntities(match[1]);
  const text = sanitizeText(decoded);
  return text || undefined;
}

function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;

  const basicDecoded = value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return basicDecoded
    .replace(/&#(\d+);/g, (match: string, code: string) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match: string, code: string) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
        ? String.fromCodePoint(parsed)
        : match;
    });
}
