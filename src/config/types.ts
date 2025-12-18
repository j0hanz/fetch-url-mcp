import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

export interface ExtractedLink {
  href: string;
  text: string;
  type: 'internal' | 'external' | 'image';
}

interface RequestOptions {
  /** Custom HTTP headers for the request */
  customHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (1000-60000) */
  timeout?: number;
  /** Number of retry attempts (1-10) */
  retries?: number;
}

export interface FetchUrlInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean;
  includeMetadata?: boolean;
  maxContentLength?: number;
  format?: 'jsonl' | 'markdown';
}

export interface FetchLinksInput extends RequestOptions {
  url: string;
  includeExternal?: boolean;
  includeInternal?: boolean;
  maxLinks?: number;
  filterPattern?: string;
  includeImages?: boolean;
}

export interface FetchMarkdownInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean;
  includeMetadata?: boolean;
  maxContentLength?: number;
  generateToc?: boolean;
}

export interface FetchUrlsInput extends RequestOptions {
  urls: string[];
  extractMainContent?: boolean;
  includeMetadata?: boolean;
  maxContentLength?: number;
  format?: 'jsonl' | 'markdown';
  concurrency?: number;
  continueOnError?: boolean;
}

export interface ErrorResponse {
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: Record<string, unknown>;
    stack?: string;
  };
}

export interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccessed: number;
}

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
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

export interface LinksTransformResult {
  links: ExtractedLink[];
  linkCount: number;
  filtered: number;
  truncated: boolean;
}

export interface ExtractLinksOptions {
  includeInternal: boolean;
  includeExternal: boolean;
  includeImages: boolean;
  maxLinks?: number;
  filterPattern?: RegExp;
}

export interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

export interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  toc: TocEntry[] | undefined;
  truncated: boolean;
}

export interface TransformOptions {
  extractMainContent: boolean;
  includeMetadata: boolean;
  generateToc: boolean;
  maxContentLength?: number;
}

export interface JsonlTransformResult {
  content: string;
  contentBlocks: number;
  title: string | undefined;
}

export interface SingleUrlResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  contentBlocks?: number;
  cached: boolean;
  error?: string;
  errorCode?: string;
}

export interface FetchPipelineOptions<T> {
  /** URL to fetch */
  url: string;
  /** Cache namespace (e.g., 'url', 'links', 'markdown') */
  cacheNamespace: string;
  /** Optional custom HTTP headers */
  customHeaders?: Record<string, string>;
  /** Optional: number of retry attempts (1-10, defaults to 3) */
  retries?: number;
  /** Optional: AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Optional: per-request timeout override in milliseconds */
  timeout?: number;
  /** Transform function to process HTML into desired format */
  transform: (html: string, url: string) => T;
  /** Optional: serialize result for caching (defaults to JSON.stringify) */
  serialize?: (result: T) => string;
  /** Optional: deserialize cached content */
  deserialize?: (cached: string) => T;
}

/** Result from the fetch pipeline */
export interface PipelineResult<T> {
  /** The transformed data */
  data: T;
  /** Whether result came from cache */
  fromCache: boolean;
  /** The normalized URL that was fetched */
  url: string;
  /** Timestamp of when content was fetched/cached */
  fetchedAt: string;
}

export interface ToolResponse<T = Record<string, unknown>> {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: T & Record<string, unknown>;
}

export interface BatchUrlResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  contentBlocks?: number;
  cached?: boolean;
  error?: string;
  errorCode?: string;
}

export interface BatchSummary {
  total: number;
  successful: number;
  failed: number;
  cached: number;
  totalContentBlocks: number;
}

export interface BatchResponseContent {
  [x: string]: unknown;
  results: BatchUrlResult[];
  summary: BatchSummary;
  fetchedAt: string;
}

export interface ToolErrorResponse {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: {
    [x: string]: unknown;
    error: string;
    url: string;
    errorCode: string;
  };
  isError: true;
}

// Fetcher types
export interface FetchOptions {
  customHeaders?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
}

// Content transformation types
export interface ContentTransformOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
}

export interface TruncationResult {
  readonly content: string;
  readonly truncated: boolean;
}

// Concurrency types
export type ConcurrencyLimitedExecutor = <T>(
  task: () => Promise<T>
) => Promise<T>;

export type ProgressCallback = (completed: number, total: number) => void;

export interface ConcurrencyExecutionOptions {
  readonly onProgress?: ProgressCallback;
}

export interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
}

// Tool response types
export interface ToolResponseBase {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// Link types
export type LinkType = 'internal' | 'external' | 'image';

// Logger types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadata = Record<string, unknown>;

// MCP request types
export interface McpRequestBody {
  method?: string;
  id?: string | number;
  jsonrpc?: '2.0';
  params?: unknown;
}
