import type { ToolContentBlock } from './runtime.js';

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

export interface ToolResponse<T = Record<string, unknown>> {
  [x: string]: unknown;
  content: ToolContentBlock[];
  structuredContent: T & Record<string, unknown>;
}

export interface BatchUrlResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  contentBlocks?: number;
  contentSize?: number;
  resourceUri?: string;
  resourceMimeType?: string;
  cached?: boolean;
  truncated?: boolean;
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
  content: ToolContentBlock[];
  structuredContent: {
    [x: string]: unknown;
    error: string;
    url: string;
    errorCode: string;
  };
  isError: true;
}

export interface ToolResponseBase {
  [x: string]: unknown;
  content: ToolContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
