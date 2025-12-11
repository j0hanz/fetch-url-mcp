/**
 * Utility functions for building consistent MCP tool responses
 */

/** Standard MCP tool response structure with index signature for SDK compatibility */
export interface ToolResponse<T = Record<string, unknown>> {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: T & Record<string, unknown>;
}

/**
 * Creates a success response for a tool
 * @param structuredContent - The structured data to return
 * @param pretty - Whether to pretty-print JSON (default: true)
 */
export function createSuccessResponse<T extends Record<string, unknown>>(
  structuredContent: T,
  pretty = true
): ToolResponse<T> {
  return {
    content: [
      {
        type: 'text' as const,
        text: pretty
          ? JSON.stringify(structuredContent, null, 2)
          : JSON.stringify(structuredContent),
      },
    ],
    structuredContent: structuredContent as T & Record<string, unknown>,
  };
}

/**
 * Creates a response for cached content
 * @param structuredContent - The structured data to return
 */
export function createCachedResponse<T extends Record<string, unknown>>(
  structuredContent: T
): ToolResponse<T> {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent: structuredContent as T & Record<string, unknown>,
  };
}

/** Single URL result in a batch operation */
export interface BatchUrlResult {
  url: string;
  success: boolean;
  title?: string | undefined;
  content?: string | undefined;
  contentBlocks?: number | undefined;
  cached?: boolean | undefined;
  error?: string | undefined;
  errorCode?: string | undefined;
}

/** Summary statistics for batch operations */
export interface BatchSummary {
  total: number;
  successful: number;
  failed: number;
  cached: number;
  totalContentBlocks: number;
}

/** Structured content for batch URL responses */
export interface BatchResponseContent {
  [x: string]: unknown;
  results: BatchUrlResult[];
  summary: BatchSummary;
  fetchedAt: string;
}

/**
 * Creates a response for batch URL operations
 * @param results - Array of individual URL results
 */
export function createBatchResponse(
  results: BatchUrlResult[]
): ToolResponse<BatchResponseContent> {
  const summary: BatchSummary = {
    total: results.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    cached: results.filter((r) => r.cached).length,
    totalContentBlocks: results.reduce(
      (sum, r) => sum + (r.contentBlocks ?? 0),
      0
    ),
  };

  const structuredContent: BatchResponseContent = {
    results,
    summary,
    fetchedAt: new Date().toISOString(),
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}
