import { TRUNCATION_MARKER } from '../../config/formatting.js';
import type {
  ContentTransformOptions,
  ExtractedArticle,
  ExtractedMetadata,
  MetadataBlock,
  TruncationResult,
} from '../../config/types.js';

export type { ContentTransformOptions };

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
  return shouldExtractFromArticle && article
    ? {
        type: 'metadata',
        title: article.title,
        author: article.byline,
        url,
        fetchedAt: now,
      }
    : {
        type: 'metadata',
        title: extractedMeta.title,
        description: extractedMeta.description,
        author: extractedMeta.author,
        url,
        fetchedAt: now,
      };
}

export function enforceContentLengthLimit(
  content: string,
  maxLength?: number
): TruncationResult {
  return truncateContent(content, maxLength);
}

export function truncateContent(
  content: string,
  maxLength?: number,
  suffix = TRUNCATION_MARKER
): TruncationResult {
  const shouldTruncate =
    maxLength !== undefined && maxLength > 0 && content.length > maxLength;

  if (!shouldTruncate) {
    return { content, truncated: false };
  }

  return {
    content: `${content.substring(0, maxLength)}${suffix}`,
    truncated: true,
  };
}
