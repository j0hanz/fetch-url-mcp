import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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

export type ToolContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
    }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string;
        text: string;
      };
    };

// Fetcher types
export interface FetchOptions {
  signal?: AbortSignal;
}

export interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
}

// Logger types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadata = Record<string, unknown>;

// MCP request types
export interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpRequestBody {
  jsonrpc: '2.0';
  method: string;
  id?: string | number;
  params?: McpRequestParams;
}

// Fetch pipeline types
export interface FetchPipelineOptions<T> {
  /** URL to fetch */
  url: string;
  /** Cache namespace (e.g., 'markdown') */
  cacheNamespace: string;
  /** Optional: AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Optional: cache variation input for headers/flags */
  cacheVary?: Record<string, unknown> | string;
  /** Transform function to process HTML into desired format */
  transform: (html: string, url: string) => T | Promise<T>;
  /** Optional: serialize result for caching (defaults to JSON.stringify) */
  serialize?: (result: T) => string;
  /** Optional: deserialize cached content */
  deserialize?: (cached: string) => T | undefined;
}

export interface PipelineResult<T> {
  data: T;
  fromCache: boolean;
  url: string;
  fetchedAt: string;
  cacheKey?: string | null;
}
