import type {
  BatchUrlResult,
  BatchSummary,
  BatchResponseContent,
  ToolResponse,
} from '../../config/types.js';

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
