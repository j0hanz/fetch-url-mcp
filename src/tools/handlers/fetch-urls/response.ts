import type {
  BatchResponseContent,
  BatchSummary,
  BatchUrlResult,
  ToolResponse,
} from '../../../config/types.js';
import type { ToolContentBlock } from '../../../config/types/runtime.js';

import { normalizeToolErrorCode } from '../../../utils/tool-error-handler.js';

function normalizeBatchResults(results: BatchUrlResult[]): BatchUrlResult[] {
  return results.map((result) => {
    if (!result.errorCode) return result;
    const normalized = normalizeToolErrorCode(result.errorCode);
    return normalized === result.errorCode
      ? result
      : { ...result, errorCode: normalized };
  });
}

export function createBatchResponse(
  results: BatchUrlResult[]
): ToolResponse<BatchResponseContent> {
  const normalizedResults = normalizeBatchResults(results);
  const summary = buildBatchSummary(normalizedResults);
  const resultsMetadata = normalizedResults.map((result) => {
    if (!result.success || !result.content) return result;
    const { content: _, ...rest } = result;
    return rest;
  });

  const structuredContent: BatchResponseContent = {
    results: normalizedResults,
    summary,
    fetchedAt: new Date().toISOString(),
  };

  const contentBlocks = buildContentBlocks(
    normalizedResults,
    resultsMetadata,
    summary
  );

  return {
    content: contentBlocks,
    structuredContent,
  };
}

function buildContentBlocks(
  fullResults: BatchUrlResult[],
  metadataResults: Partial<BatchUrlResult>[],
  summary: BatchSummary
): ToolContentBlock[] {
  const blocks: ToolContentBlock[] = [];
  blocks.push({
    type: 'text',
    text: JSON.stringify(
      {
        results: metadataResults,
        summary,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2
    ),
  });
  fullResults.forEach((result) => {
    if (result.success && result.content) {
      blocks.push({
        type: 'text',
        text: `\n--- Content from ${result.url} ---\n${result.content}`,
      });
    }
  });
  blocks.push(...buildResourceLinks(fullResults));

  return blocks;
}

function buildBatchSummary(results: BatchUrlResult[]): BatchSummary {
  return {
    total: results.length,
    successful: countBy(results, (result) => result.success),
    failed: countBy(results, (result) => !result.success),
    cached: countBy(results, (result) => Boolean(result.cached)),
    totalContentBlocks: sumBy(results, (result) => result.contentBlocks ?? 0),
  };
}

function buildResourceLinks(results: BatchUrlResult[]): ToolContentBlock[] {
  return results.filter(hasResourceUri).map((result) => ({
    type: 'resource_link' as const,
    uri: result.resourceUri,
    name: `Fetched content for ${result.url}`,
    mimeType: result.resourceMimeType,
  }));
}

function hasResourceUri(
  result: BatchUrlResult
): result is BatchUrlResult & { resourceUri: string } {
  return typeof result.resourceUri === 'string';
}

function countBy<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.reduce(
    (count, item) => (predicate(item) ? count + 1 : count),
    0
  );
}

function sumBy<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}
