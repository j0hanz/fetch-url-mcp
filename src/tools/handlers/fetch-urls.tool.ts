import * as cheerio from 'cheerio';

import type {
  BatchUrlResult,
  FetchUrlsInput,
  MetadataBlock,
  SingleUrlResult,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
import { extractContent } from '../../services/extractor.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { logDebug, logError, logWarn } from '../../services/logger.js';
import { parseHtml } from '../../services/parser.js';

import { runWithConcurrency } from '../../utils/concurrency.js';
import { createToolErrorResponse } from '../../utils/tool-error-handler.js';
import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import {
  buildMetadata,
  shouldUseArticle,
  truncateContent,
} from '../utils/common.js';
import { createBatchResponse } from '../utils/response-builder.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

export const FETCH_URLS_TOOL_NAME = 'fetch-urls';
export const FETCH_URLS_TOOL_DESCRIPTION =
  'Fetches multiple URLs in parallel and converts them to AI-readable format (JSONL or Markdown). Supports concurrency control and continues on individual failures.';

const MAX_URLS = 10;
const DEFAULT_CONCURRENCY = 3;

interface ProcessOptions {
  extractMainContent: boolean;
  includeMetadata: boolean;
  maxContentLength?: number | undefined;
  format: 'jsonl' | 'markdown';
}

// Fast metadata extraction using Cheerio only (no JSDOM)
function extractMetadataFast(html: string): {
  title?: string;
  description?: string;
  author?: string;
} {
  const $ = cheerio.load(html);
  const getMetaContent = (selectors: string[]): string | undefined => {
    for (const selector of selectors) {
      const content = $(selector).attr('content');
      if (content) return content;
    }
    return undefined;
  };

  const title =
    getMetaContent([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ??
    ($('title').text() || undefined);

  const description = getMetaContent([
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  const author = getMetaContent([
    'meta[name="author"]',
    'meta[property="article:author"]',
  ]);

  return { title, description, author };
}

async function processSingleUrl(
  url: string,
  options: ProcessOptions
): Promise<SingleUrlResult> {
  try {
    const normalizedUrl = validateAndNormalizeUrl(url);
    const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
    const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

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

    const fetchResult = await fetchUrlWithRetry(normalizedUrl);

    let sourceHtml: string;
    let title: string | undefined;
    let metadata: MetadataBlock | undefined;

    // Fast path: Skip JSDOM entirely when extractMainContent is false
    if (!options.extractMainContent) {
      sourceHtml = fetchResult.html;
      const extractedMeta = extractMetadataFast(fetchResult.html);
      ({ title } = extractedMeta);

      if (options.includeMetadata) {
        metadata = {
          type: 'metadata' as const,
          url: normalizedUrl,
          fetchedAt: new Date().toISOString(),
          title: extractedMeta.title,
          description: extractedMeta.description,
          author: extractedMeta.author,
        };
      }
    } else {
      // Slow path: Use JSDOM only when article extraction is needed
      const { article, metadata: extractedMeta } = extractContent(
        fetchResult.html,
        normalizedUrl,
        {
          extractArticle: true,
        }
      );
      const useArticle = shouldUseArticle(true, article);
      metadata = buildMetadata(
        normalizedUrl,
        article,
        extractedMeta,
        useArticle,
        options.includeMetadata
      );
      sourceHtml = useArticle ? article.content : fetchResult.html;
      title = useArticle ? article.title : extractedMeta.title;
    }

    let content: string;
    let contentBlocks: number | undefined;

    if (options.format === 'markdown') {
      content = htmlToMarkdown(sourceHtml, metadata);
    } else {
      const blocks = parseHtml(sourceHtml);
      contentBlocks = blocks.length;
      content = toJsonl(blocks, metadata);
    }

    const { content: truncatedContent } = truncateContent(
      content,
      options.maxContentLength
    );
    content = truncatedContent;
    if (cacheKey) cache.set(cacheKey, content);

    return {
      url: normalizedUrl,
      success: true,
      title,
      content,
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

export async function fetchUrlsToolHandler(input: FetchUrlsInput): Promise<{
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
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

    // Helper to safely extract error message from rejected promise
    const getErrorMessage = ({ reason }: PromiseRejectedResult): string => {
      const typedReason: unknown = reason;
      return typedReason instanceof Error
        ? typedReason.message
        : String(typedReason);
    };

    // Process results
    const results: BatchUrlResult[] = settledResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        // Promise rejection (shouldn't happen as processSingleUrl catches errors)
        return {
          url: validUrls[index] ?? 'unknown',
          success: false as const,
          cached: false as const,
          error: getErrorMessage(result),
          errorCode: 'PROMISE_REJECTED',
        };
      }
    });

    // Check if we should fail fast on errors
    if (!continueOnError) {
      const firstError = results.find((r) => !r.success);
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
