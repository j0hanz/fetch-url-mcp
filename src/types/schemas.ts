/**
 * Tool input types - used for type safety in tool handlers
 */

export interface FetchUrlInput {
  url: string;
  extractMainContent?: boolean;
  includeMetadata?: boolean;
  maxContentLength?: number;
  format?: 'jsonl' | 'markdown';
  customHeaders?: Record<string, string>;
}

export interface FetchLinksInput {
  url: string;
  includeExternal?: boolean;
  includeInternal?: boolean;
}

export interface FetchMarkdownInput {
  url: string;
  extractMainContent?: boolean;
  includeMetadata?: boolean;
}
