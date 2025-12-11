import { config } from '../../config/index.js';
import type {
  ExtractedArticle,
  ExtractedMetadata,
  MetadataBlock,
} from '../../config/types.js';

export function shouldUseArticle(
  extractMainContent: boolean,
  article: ExtractedArticle | null
): article is ExtractedArticle {
  return (
    extractMainContent && config.extraction.extractMainContent && !!article
  );
}

export function buildMetadata(
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  useArticle: boolean,
  includeMetadata: boolean
): MetadataBlock | undefined {
  if (!includeMetadata || !config.extraction.includeMetadata) return undefined;
  const now = new Date().toISOString();
  return useArticle && article
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

export function truncateContent(
  content: string,
  maxLength?: number
): { content: string; truncated: boolean } {
  if (!maxLength || maxLength <= 0 || content.length <= maxLength) {
    return { content, truncated: false };
  }
  return {
    content: content.substring(0, maxLength) + '\n...[truncated]',
    truncated: true,
  };
}
