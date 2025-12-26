import type {
  ExtractLinksOptions,
  FetchLinksInput,
  LinksTransformResult,
  PipelineResult,
  ToolResponseBase,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { appendHeaderVary } from '../utils/cache-vary.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

import {
  extractLinks,
  resolveFilterPattern,
} from './fetch-links/link-extractor.js';

export const FETCH_LINKS_TOOL_NAME = 'fetch-links';
export const FETCH_LINKS_TOOL_DESCRIPTION =
  'Extracts all hyperlinks from a webpage with anchor text and type classification. Supports filtering, image links, and link limits.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isToolResponseBase(value: unknown): value is ToolResponseBase {
  if (!isRecord(value)) return false;
  if (!('content' in value)) return false;
  return Array.isArray((value as ToolResponseBase).content);
}

function logFetchLinksStart(
  url: string,
  options: ExtractLinksOptions,
  filterPattern: string | undefined
): void {
  logDebug('Extracting links', {
    url,
    ...options,
    filterPattern,
  });
}

async function fetchLinksPipeline(
  url: string,
  input: FetchLinksInput,
  options: ExtractLinksOptions
): Promise<PipelineResult<LinksTransformResult>> {
  return executeFetchPipeline<LinksTransformResult>({
    url,
    cacheNamespace: 'links',
    customHeaders: input.customHeaders,
    retries: input.retries,
    cacheVary: appendHeaderVary(
      {
        includeInternal: options.includeInternal,
        includeExternal: options.includeExternal,
        includeImages: options.includeImages,
        maxLinks: options.maxLinks,
        filterPattern: input.filterPattern ?? null,
      },
      input.customHeaders
    ),
    transform: (html, normalizedUrl) =>
      extractLinks(html, normalizedUrl, options),
  });
}

function buildLinksResponse(
  result: PipelineResult<LinksTransformResult>
): ToolResponseBase {
  const structuredContent = buildLinksStructuredContent(result);
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

export async function fetchLinksToolHandler(
  input: FetchLinksInput
): Promise<ToolResponseBase> {
  try {
    return await executeFetchLinks(input);
  } catch (error) {
    logError(
      'fetch-links tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to extract links');
  }
}

async function executeFetchLinks(
  input: FetchLinksInput
): Promise<ToolResponseBase> {
  const { url } = input;
  if (!url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }
  const filterPattern = resolveFilterPattern(input.filterPattern, url);
  if (isToolResponseBase(filterPattern)) {
    return filterPattern;
  }

  const options = buildExtractOptions(input, filterPattern);

  logFetchLinksStart(url, options, input.filterPattern);
  const result = await fetchLinksPipeline(url, input, options);
  return buildLinksResponse(result);
}

function buildExtractOptions(
  input: FetchLinksInput,
  filterPattern: RegExp | undefined
): ExtractLinksOptions {
  return {
    includeInternal: input.includeInternal ?? true,
    includeExternal: input.includeExternal ?? true,
    includeImages: input.includeImages ?? false,
    maxLinks: input.maxLinks,
    filterPattern,
  };
}

function buildLinksStructuredContent(
  result: PipelineResult<LinksTransformResult>
): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    url: result.url,
    linkCount: result.data.linkCount,
    links: result.data.links,
  };

  if (result.data.filtered > 0) {
    structuredContent.filtered = result.data.filtered;
  }

  if (result.data.truncated) {
    structuredContent.truncated = result.data.truncated;
  }

  return structuredContent;
}
