import type { ToolContentBlock } from './runtime.js';

interface RequestOptions {
  /** Custom HTTP headers for the request */
  customHeaders?: Record<string, string> | undefined;
  /** Request timeout in milliseconds (1000-120000) */
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
  includeContentBlocks?: boolean | undefined;
}

export interface FetchMarkdownInput extends RequestOptions {
  url: string;
  extractMainContent?: boolean | undefined;
  includeMetadata?: boolean | undefined;
  maxContentLength?: number | undefined;
}

export interface FileDownloadInfo {
  downloadUrl: string;
  fileName: string;
  expiresAt: string;
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

export interface ToolErrorResponse {
  [x: string]: unknown;
  content: ToolContentBlock[];
  structuredContent: {
    error: string;
    url: string;
    errorCode: string;
  } & Record<string, unknown>;
  isError: true;
}

export interface ToolResponseBase {
  [x: string]: unknown;
  content: ToolContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
