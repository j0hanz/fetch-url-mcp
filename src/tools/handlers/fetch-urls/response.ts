import type {
  BatchResponseContent,
  BatchSummary,
  BatchUrlResult,
  ToolResponse,
} from '../../../config/types.js';

export function createBatchResponse(
  results: BatchUrlResult[]
): ToolResponse<BatchResponseContent> {
  const summary: BatchSummary = {
    total: results.length,
    successful: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    cached: results.filter((result) => result.cached).length,
    totalContentBlocks: results.reduce(
      (sum, result) => sum + (result.contentBlocks ?? 0),
      0
    ),
  };

  const structuredContent: BatchResponseContent = {
    results,
    summary,
    fetchedAt: new Date().toISOString(),
  };

  const resourceLinks = results
    .filter(
      (result): result is BatchUrlResult & { resourceUri: string } =>
        typeof result.resourceUri === 'string'
    )
    .map((result) => ({
      type: 'resource_link' as const,
      uri: result.resourceUri,
      name: `Fetched content for ${result.url}`,
      mimeType: result.resourceMimeType,
    }));

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
      ...resourceLinks,
    ],
    structuredContent,
  };
}
