import type {
  BatchResponseContent,
  BatchSummary,
  BatchUrlResult,
  FetchOptions,
  FetchUrlsInput,
  MetadataBlock,
  ToolResponse,
  ToolResponseBase,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
import { extractContent } from '../../services/extractor.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { logDebug, logError, logWarn } from '../../services/logger.js';
import { parseHtml } from '../../services/parser.js';

import { createToolErrorResponse } from '../../utils/tool-error-handler.js';
import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  enforceContentLengthLimit,
} from '../utils/common.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

const MAX_URLS_PER_BATCH = 10;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 5;

export const FETCH_URLS_TOOL_NAME = 'fetch-urls';
export const FETCH_URLS_TOOL_DESCRIPTION =
  'Fetches multiple URLs in parallel and converts them to AI-readable format (JSONL or Markdown). Supports concurrency control and continues on individual failures.';

function createBatchResponse(
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

interface SingleUrlProcessOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly maxContentLength?: number;
  readonly format: 'jsonl' | 'markdown';
  readonly requestOptions?: FetchOptions;
  readonly maxRetries?: number;
}

interface SingleUrlResult {
  url: string;
  success: boolean;
  title?: string;
  content?: string;
  contentBlocks?: number;
  cached: boolean;
  error?: string;
  errorCode?: string;
}

function attemptCacheRetrievalForUrl(
  normalizedUrl: string,
  format: 'jsonl' | 'markdown'
): SingleUrlResult | null {
  const cacheNamespace = format === 'markdown' ? 'markdown' : 'url';
  const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

  if (!cacheKey) return null;

  const cached = cache.get(cacheKey);
  if (!cached) return null;

  logDebug('Batch cache hit', { url: normalizedUrl });
  return {
    url: normalizedUrl,
    success: true,
    content: cached.content,
    cached: true,
  };
}

function transformContentForFormat(
  html: string,
  normalizedUrl: string,
  metadata: MetadataBlock | undefined,
  format: 'jsonl' | 'markdown'
): { content: string; contentBlocks?: number } {
  if (format === 'markdown') {
    return {
      content: htmlToMarkdown(html, metadata),
    };
  }

  const blocks = parseHtml(html);
  return {
    content: toJsonl(blocks, metadata),
    contentBlocks: blocks.length,
  };
}

function processContentExtraction(
  html: string,
  normalizedUrl: string,
  options: SingleUrlProcessOptions
): {
  sourceHtml: string;
  title: string | undefined;
  metadata: MetadataBlock | undefined;
} {
  if (!options.extractMainContent) {
    const { metadata: extractedMeta } = extractContent(html, normalizedUrl, {
      extractArticle: false,
    });
    return {
      sourceHtml: html,
      title: extractedMeta.title,
      metadata: createContentMetadataBlock(
        normalizedUrl,
        null,
        extractedMeta,
        false,
        options.includeMetadata
      ),
    };
  }

  const { article, metadata: extractedMeta } = extractContent(
    html,
    normalizedUrl,
    { extractArticle: true }
  );

  const shouldExtractFromArticle = determineContentExtractionSource(
    true,
    article
  );

  return {
    sourceHtml: shouldExtractFromArticle ? article.content : html,
    title: shouldExtractFromArticle ? article.title : extractedMeta.title,
    metadata: createContentMetadataBlock(
      normalizedUrl,
      article,
      extractedMeta,
      shouldExtractFromArticle,
      options.includeMetadata
    ),
  };
}

async function processSingleUrl(
  url: string,
  options: SingleUrlProcessOptions
): Promise<SingleUrlResult> {
  try {
    const normalizedUrl = validateAndNormalizeUrl(url);

    const cachedResult = attemptCacheRetrievalForUrl(
      normalizedUrl,
      options.format
    );
    if (cachedResult) return cachedResult;

    const html = await fetchUrlWithRetry(
      normalizedUrl,
      options.requestOptions,
      options.maxRetries
    );

    const { sourceHtml, title, metadata } = processContentExtraction(
      html,
      normalizedUrl,
      options
    );

    const { content, contentBlocks } = transformContentForFormat(
      sourceHtml,
      normalizedUrl,
      metadata,
      options.format
    );

    const { content: finalContent } = enforceContentLengthLimit(
      content,
      options.maxContentLength
    );

    const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
    const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);
    if (cacheKey) {
      cache.set(cacheKey, finalContent);
    }

    return {
      url: normalizedUrl,
      success: true,
      title,
      content: finalContent,
      contentBlocks,
      cached: false,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const errorCode =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'FETCH_ERROR';

    logWarn('Batch URL processing failed', { url, error: errorMessage });

    return {
      url,
      success: false,
      cached: false,
      error: errorMessage,
      errorCode,
    };
  }
}

function extractRejectionMessage({ reason }: PromiseRejectedResult): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (
    reason &&
    typeof reason === 'object' &&
    'message' in reason &&
    typeof (reason as Record<string, unknown>).message === 'string'
  ) {
    const msg = (reason as Record<string, unknown>).message;
    return msg as string;
  }
  return 'Unknown error';
}

function validateBatchInput(
  input: FetchUrlsInput
): string[] | ToolResponseBase {
  if (input.urls.length === 0) {
    return createToolErrorResponse(
      'At least one URL is required',
      '',
      'VALIDATION_ERROR'
    );
  }

  if (input.urls.length > MAX_URLS_PER_BATCH) {
    return createToolErrorResponse(
      `Maximum ${MAX_URLS_PER_BATCH} URLs allowed per batch`,
      '',
      'VALIDATION_ERROR'
    );
  }

  const validUrls = input.urls.filter(
    (url) => typeof url === 'string' && url.trim().length > 0
  );

  if (validUrls.length === 0) {
    return createToolErrorResponse(
      'No valid URLs provided',
      '',
      'VALIDATION_ERROR'
    );
  }

  return validUrls;
}

export async function fetchUrlsToolHandler(
  input: FetchUrlsInput
): Promise<ToolResponseBase> {
  try {
    const validationResult = validateBatchInput(input);
    if (!Array.isArray(validationResult)) {
      return validationResult;
    }

    const validUrls = validationResult;
    const concurrency = Math.min(
      Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY),
      MAX_CONCURRENCY
    );
    const continueOnError = input.continueOnError ?? true;
    const format = input.format ?? 'jsonl';

    logDebug('Starting batch URL fetch', {
      urlCount: validUrls.length,
      concurrency,
      format,
    });

    const processOptions: SingleUrlProcessOptions = {
      extractMainContent: input.extractMainContent ?? true,
      includeMetadata: input.includeMetadata ?? true,
      maxContentLength: input.maxContentLength,
      format,
      requestOptions: {
        customHeaders: input.customHeaders,
        timeout: input.timeout,
      },
      maxRetries: input.retries,
    };

    // Process URLs in batches using native Promise.allSettled
    const results: BatchUrlResult[] = [];
    const batchSize = Math.min(concurrency, validUrls.length);

    for (let i = 0; i < validUrls.length; i += batchSize) {
      const batch = validUrls.slice(i, i + batchSize);
      const batchTasks = batch.map((url) =>
        processSingleUrl(url, processOptions)
      );

      logDebug('Processing batch', {
        batch: i / batchSize + 1,
        urls: batch.length,
        total: validUrls.length,
      });

      const settledResults = await Promise.allSettled(batchTasks);

      const batchResults: BatchUrlResult[] = settledResults.map(
        (result, index) => {
          if (result.status === 'fulfilled') {
            return result.value;
          }
          return {
            url: batch[index] ?? 'unknown',
            success: false as const,
            cached: false as const,
            error: extractRejectionMessage(result),
            errorCode: 'PROMISE_REJECTED',
          };
        }
      );

      results.push(...batchResults);
    }

    if (!continueOnError) {
      const firstError = results.find((result) => !result.success);
      if (firstError && !firstError.success) {
        const errorMsg = firstError.error ?? 'Unknown error';
        return createToolErrorResponse(
          `Batch failed: ${errorMsg}`,
          firstError.url,
          firstError.errorCode ?? 'BATCH_ERROR'
        );
      }
    }

    return createBatchResponse(results);
  } catch (error) {
    logError(
      'fetch-urls tool error',
      error instanceof Error ? error : undefined
    );

    return createToolErrorResponse(
      error instanceof Error ? error.message : 'Failed to fetch URLs',
      '',
      'BATCH_ERROR'
    );
  }
}
