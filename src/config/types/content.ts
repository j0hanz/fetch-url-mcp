type ContentBlockType =
  | 'metadata'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'code'
  | 'table'
  | 'image'
  | 'blockquote';

interface ContentBlock {
  type: ContentBlockType;
}

export interface MetadataBlock extends ContentBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

export interface HeadingBlock extends ContentBlock {
  type: 'heading';
  level: number;
  text: string;
}

export interface ParagraphBlock extends ContentBlock {
  type: 'paragraph';
  text: string;
}

export interface ListBlock extends ContentBlock {
  type: 'list';
  ordered: boolean;
  items: string[];
}

export interface CodeBlock extends ContentBlock {
  type: 'code';
  language?: string;
  text: string;
}

export interface TableBlock extends ContentBlock {
  type: 'table';
  headers?: string[];
  rows: string[][];
}

export interface ImageBlock extends ContentBlock {
  type: 'image';
  src: string;
  alt?: string;
}

export interface BlockquoteBlock extends ContentBlock {
  type: 'blockquote';
  text: string;
}

export type ContentBlockUnion =
  | MetadataBlock
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | TableBlock
  | ImageBlock
  | BlockquoteBlock;

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

export type ParseableTagName =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'p'
  | 'ul'
  | 'ol'
  | 'pre'
  | 'code'
  | 'table'
  | 'img'
  | 'blockquote';

export interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  truncated: boolean;
}

export interface TransformOptions {
  extractMainContent: boolean;
  includeMetadata: boolean;
  maxContentLength?: number;
}

export interface JsonlTransformResult {
  content: string;
  contentBlocks: number;
  title: string | undefined;
  truncated?: boolean;
}
