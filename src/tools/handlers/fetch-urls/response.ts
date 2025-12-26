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
  const structuredContent: BatchResponseContent = {
    results: normalizedResults,
    summary,
    fetchedAt: new Date().toISOString(),
  };

  const resourceLinks = buildResourceLinks(normalizedResults);

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
