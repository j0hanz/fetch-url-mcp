export interface MetadataBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

export interface ExtractedArticle {
  title?: string;
  byline?: string;
  content: string;
  textContent: string;
  excerpt?: string;
  siteName?: string;
}

export interface CacheEntry {
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface ExtractedMetadata {
  title?: string;
  description?: string;
  author?: string;
}

export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

export interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  truncated: boolean;
}

export interface TransformOptions {
  includeMetadata: boolean;
}
