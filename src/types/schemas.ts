/**
 * Tool input types - used for type safety in tool handlers
 */

/** Common request options shared across tools */
export interface RequestOptions {
  /** Custom HTTP headers for the request */
  customHeaders?: Record<string, string> | undefined;
  /** Request timeout in milliseconds (1000-60000) */
  timeout?: number | undefined;
  /** Number of retry attempts (1-10) */
  retries?: number | undefined;
}

export interface FetchUrlInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean | undefined;
  includeMetadata?: boolean | undefined;
  maxContentLength?: number | undefined;
  format?: 'jsonl' | 'markdown' | undefined;
}

export interface FetchLinksInput extends RequestOptions {
  url: string;
  includeExternal?: boolean | undefined;
  includeInternal?: boolean | undefined;
  /** Maximum number of links to return */
  maxLinks?: number | undefined;
  /** Regex pattern to filter links (matches against href) */
  filterPattern?: string | undefined;
  /** Include image links (img src attributes) */
  includeImages?: boolean | undefined;
}

export interface FetchMarkdownInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean | undefined;
  includeMetadata?: boolean | undefined;
  /** Maximum content length in characters */
  maxContentLength?: number | undefined;
  /** Generate table of contents from headings */
  generateToc?: boolean | undefined;
}

export interface FetchUrlsInput extends RequestOptions {
  urls: string[];
  extractMainContent?: boolean | undefined;
  includeMetadata?: boolean | undefined;
  maxContentLength?: number | undefined;
  format?: 'jsonl' | 'markdown' | undefined;
  concurrency?: number | undefined;
  continueOnError?: boolean | undefined;
}
