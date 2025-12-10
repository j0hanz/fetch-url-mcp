// Content block types for JSONL output
type ContentBlockType =
  | 'metadata'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'code'
  | 'table'
  | 'image';

// Base content block
interface ContentBlock {
  type: ContentBlockType;
}

// Metadata block
export interface MetadataBlock extends ContentBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

// Heading block
export interface HeadingBlock extends ContentBlock {
  type: 'heading';
  level: number;
  text: string;
}

// Paragraph block
export interface ParagraphBlock extends ContentBlock {
  type: 'paragraph';
  text: string;
}

// List block
export interface ListBlock extends ContentBlock {
  type: 'list';
  ordered: boolean;
  items: string[];
}

// Code block
export interface CodeBlock extends ContentBlock {
  type: 'code';
  language?: string;
  text: string;
}

// Table block
export interface TableBlock extends ContentBlock {
  type: 'table';
  headers?: string[];
  rows: string[][];
}

// Image block
export interface ImageBlock extends ContentBlock {
  type: 'image';
  src: string;
  alt?: string;
}

// Union type for all content blocks
export type ContentBlockUnion =
  | MetadataBlock
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | TableBlock
  | ImageBlock;

// Extracted article
export interface ExtractedArticle {
  title?: string;
  byline?: string;
  content: string;
  textContent: string;
  excerpt?: string;
  siteName?: string;
}

// Cache entry
export interface CacheEntry {
  url: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}

// Link extraction result
export interface ExtractedLink {
  href: string;
  text: string;
  type: 'internal' | 'external';
}
