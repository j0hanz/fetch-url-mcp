import type {
  ExtractedArticle,
  ExtractedMetadata,
  MetadataBlock,
} from '../../config/types/content.js';

const MIN_CONTENT_RATIO = 0.3;
const MIN_HTML_LENGTH_FOR_GATE = 100;

function stripHtmlTags(html: string): string {
  const parts: string[] = [];
  let inTag = false;

  for (const char of html) {
    if (char === '<') {
      inTag = true;
      continue;
    }
    if (char === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) {
      parts.push(char);
    }
  }

  return parts.join('');
}

function estimateTextLength(html: string): number {
  return stripHtmlTags(html).replace(/\s+/g, ' ').trim().length;
}

export function isExtractionSufficient(
  article: ExtractedArticle | null,
  originalHtml: string
): boolean {
  if (!article) return false;

  const articleLength = article.textContent.length;
  const originalLength = estimateTextLength(originalHtml);

  if (originalLength < MIN_HTML_LENGTH_FOR_GATE) return true;

  return articleLength / originalLength >= MIN_CONTENT_RATIO;
}

export function determineContentExtractionSource(
  article: ExtractedArticle | null
): article is ExtractedArticle {
  return !!article;
}

function applyArticleMetadata(
  metadata: MetadataBlock,
  article: ExtractedArticle
): void {
  if (article.title !== undefined) metadata.title = article.title;
  if (article.byline !== undefined) metadata.author = article.byline;
}

function applyExtractedMetadata(
  metadata: MetadataBlock,
  extractedMeta: ExtractedMetadata
): void {
  if (extractedMeta.title !== undefined) metadata.title = extractedMeta.title;
  if (extractedMeta.description !== undefined) {
    metadata.description = extractedMeta.description;
  }
  if (extractedMeta.author !== undefined) {
    metadata.author = extractedMeta.author;
  }
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
    applyArticleMetadata(metadata, article);
    return metadata;
  }

  applyExtractedMetadata(metadata, extractedMeta);

  return metadata;
}
