import type {
  BatchUrlResult,
  FetchUrlsInput,
  ToolResponseBase,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import { createToolErrorResponse } from '../../utils/tool-error-handler.js';

import {
  processSingleUrl,
  type SingleUrlProcessOptions,
} from './fetch-urls/processor.js';
import { createBatchResponse } from './fetch-urls/response.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  validateBatchInput,
} from './fetch-urls/validation.js';

export const FETCH_URLS_TOOL_NAME = 'fetch-urls';
export const FETCH_URLS_TOOL_DESCRIPTION =
  'Fetches multiple URLs in parallel and converts them to AI-readable format (JSONL or Markdown). Supports concurrency control and continues on individual failures.';

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
    return (reason as Record<string, unknown>).message as string;
  }
  return 'Unknown error';
}

function normalizeConcurrency(input: FetchUrlsInput, urlCount: number): number {
  const requested = input.concurrency ?? DEFAULT_CONCURRENCY;
  return Math.min(Math.max(1, requested), MAX_CONCURRENCY, urlCount);
}

async function processBatch(
  urls: string[],
  options: SingleUrlProcessOptions,
  batchIndex: number,
  total: number
): Promise<PromiseSettledResult<BatchUrlResult>[]> {
  logDebug('Processing batch', {
    batch: batchIndex,
    urls: urls.length,
    total,
  });

  const tasks = urls.map((url) => processSingleUrl(url, options));
  return Promise.allSettled(tasks);
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
    const concurrency = normalizeConcurrency(input, validUrls.length);
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

    const results: BatchUrlResult[] = [];
    const batchSize = Math.min(concurrency, validUrls.length);

    for (let i = 0; i < validUrls.length; i += batchSize) {
      const batch = validUrls.slice(i, i + batchSize);
      const settledResults = await processBatch(
        batch,
        processOptions,
        i / batchSize + 1,
        validUrls.length
      );

      const batchResults = settledResults.map((result, index) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              url: batch[index] ?? 'unknown',
              success: false as const,
              cached: false as const,
              error: extractRejectionMessage(result),
              errorCode: 'PROMISE_REJECTED',
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
