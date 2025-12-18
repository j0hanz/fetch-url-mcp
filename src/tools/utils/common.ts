import type {
  ExtractedArticle,
  ExtractedMetadata,
  MetadataBlock,
} from '../../config/types.js';

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
): { content: string; truncated: boolean } {
  if (!maxLength || maxLength <= 0 || content.length <= maxLength) {
    return { content, truncated: false };
  }
  return {
    content: `${content.substring(0, maxLength)}\n...[truncated]`,
    truncated: true,
  };
}
