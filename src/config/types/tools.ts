import type { ToolContentBlock } from './runtime.js';

interface RequestOptions {
  /** Custom HTTP headers for the request */
  customHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (1000-120000) */
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

export interface FetchMarkdownInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean;
  includeMetadata?: boolean;
  maxContentLength?: number;
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
