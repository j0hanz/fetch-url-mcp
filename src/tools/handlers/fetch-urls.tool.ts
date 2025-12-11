import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';
import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';
import * as cache from '../../services/cache.js';
import { config } from '../../config/index.js';
import { logDebug, logError, logWarn } from '../../services/logger.js';
import { runWithConcurrency } from '../../utils/concurrency.js';
import { createBatchResponse } from '../utils/response-builder.js';
import { createToolErrorResponse } from '../../utils/tool-error-handler.js';
import type {
  FetchUrlsInput,
  MetadataBlock,
  ContentBlockUnion,
  SingleUrlResult,
  BatchUrlResult,
} from '../../config/types.js';

export const FETCH_URLS_TOOL_NAME = 'fetch-urls';
export const FETCH_URLS_TOOL_DESCRIPTION =
  'Fetches multiple URLs in parallel and converts them to AI-readable format (JSONL or Markdown). Supports concurrency control and continues on individual failures.';

const MAX_URLS = 10;
const DEFAULT_CONCURRENCY = 3;

async function processSingleUrl(
  url: string,
  options: {
    extractMainContent: boolean;
    includeMetadata: boolean;
    maxContentLength?: number | undefined;
    format: 'jsonl' | 'markdown';
  }
): Promise<SingleUrlResult> {
  try {
    // Validate URL
    const normalizedUrl = validateAndNormalizeUrl(url);
    const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
    const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

    // Check cache first
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        logDebug('Batch cache hit', { url: normalizedUrl });
        return {
          url: normalizedUrl,
          success: true,
          content: cached.content,
          cached: true,
        };
      }
    }

    // Fetch HTML (uses HTML cache internally)
    const fetchResult = await fetchUrlWithRetry(normalizedUrl);

    if (!fetchResult.html) {
      return {
        url: normalizedUrl,
        success: false,
        cached: false,
        error: 'No content received from URL',
        errorCode: 'EMPTY_CONTENT',
      };
    }

    const html = fetchResult.html;

    // Extract content
    const { article, metadata: extractedMeta } = extractContent(
      html,
      normalizedUrl
    );

    let content: string;
    let title: string | undefined;
    let contentBlocks = 0;

    if (options.format === 'markdown') {
      // Markdown format
      if (
        options.extractMainContent &&
        config.extraction.extractMainContent &&
        article
      ) {
        const metadata =
          options.includeMetadata && config.extraction.includeMetadata
            ? {
                type: 'metadata' as const,
                title: article.title,
                author: article.byline,
                url: normalizedUrl,
                fetchedAt: new Date().toISOString(),
              }
            : undefined;

        content = htmlToMarkdown(article.content, metadata);
        title = article.title;
      } else {
        const metadata =
          options.includeMetadata && config.extraction.includeMetadata
            ? {
                type: 'metadata' as const,
                title: extractedMeta.title,
                description: extractedMeta.description,
                author: extractedMeta.author,
                url: normalizedUrl,
                fetchedAt: new Date().toISOString(),
              }
            : undefined;

        content = htmlToMarkdown(html, metadata);
        title = extractedMeta.title;
      }
    } else {
      // JSONL format
      let blocks: ContentBlockUnion[];
      let metadata: MetadataBlock | undefined;

      if (
        options.extractMainContent &&
        config.extraction.extractMainContent &&
        article
      ) {
        blocks = parseHtml(article.content);
        metadata =
          options.includeMetadata && config.extraction.includeMetadata
            ? {
                type: 'metadata' as const,
                title: article.title,
                author: article.byline,
                url: normalizedUrl,
                fetchedAt: new Date().toISOString(),
              }
            : undefined;
        title = article.title;
      } else {
        blocks = parseHtml(html);
        metadata =
          options.includeMetadata && config.extraction.includeMetadata
            ? {
                type: 'metadata' as const,
                title: extractedMeta.title,
                description: extractedMeta.description,
                author: extractedMeta.author,
                url: normalizedUrl,
                fetchedAt: new Date().toISOString(),
              }
            : undefined;
        title = extractedMeta.title;
      }

      contentBlocks = blocks.length;
      content = toJsonl(blocks, metadata);
    }

    // Apply max content length truncation
    if (
      options.maxContentLength &&
      options.maxContentLength > 0 &&
      content.length > options.maxContentLength
    ) {
      content =
        content.substring(0, options.maxContentLength) + '\n...[truncated]';
    }

    // Cache the result
    if (cacheKey) {
      cache.set(cacheKey, content);
    }

    return {
      url: normalizedUrl,
      success: true,
      title,
      content,
      contentBlocks: options.format === 'jsonl' ? contentBlocks : undefined,
      cached: false,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const errorCode =
      error instanceof Error && 'code' in error
        ? String((error as { code?: string }).code)
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

export async function fetchUrlsToolHandler(input: FetchUrlsInput) {
  try {
    // Validate input - urls array is guaranteed by Zod schema but check for empty
    if (input.urls.length === 0) {
      return createToolErrorResponse(
        'At least one URL is required',
        '',
        'VALIDATION_ERROR'
      );
    }

    // Enforce max URLs limit
    if (input.urls.length > MAX_URLS) {
      return createToolErrorResponse(
        `Maximum ${MAX_URLS} URLs allowed per batch`,
        '',
        'VALIDATION_ERROR'
      );
    }

    // Filter out empty URLs
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

    const concurrency = Math.min(
      Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY),
      5
    );
    const continueOnError = input.continueOnError ?? true;
    const format = input.format ?? 'jsonl';

    logDebug('Starting batch URL fetch', {
      urlCount: validUrls.length,
      concurrency,
      format,
    });

    // Create tasks for each URL
    const tasks = validUrls.map(
      (url) => async () =>
        processSingleUrl(url, {
          extractMainContent: input.extractMainContent ?? true,
          includeMetadata: input.includeMetadata ?? true,
          maxContentLength: input.maxContentLength,
          format,
        })
    );

    // Execute with concurrency control
    const settledResults = await runWithConcurrency(concurrency, tasks);

    // Process results
    const results: BatchUrlResult[] = settledResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        // Promise rejection (shouldn't happen as processSingleUrl catches errors)
        const reason = result.reason as Error | undefined;
        return {
          url: validUrls[index] ?? 'unknown',
          success: false as const,
          cached: false as const,
          error: reason?.message ?? 'Unknown error',
          errorCode: 'PROMISE_REJECTED',
        };
      }
    });

    // Check if we should fail fast on errors
    if (!continueOnError) {
      const firstError = results.find((r) => !r.success);
      if (firstError) {
        return createToolErrorResponse(
          `Batch failed: ${firstError.error}`,
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
