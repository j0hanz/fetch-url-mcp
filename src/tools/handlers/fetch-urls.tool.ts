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

type Format = NonNullable<FetchUrlsInput['format']>;

export const FETCH_URLS_TOOL_NAME = 'fetch-urls';
export const FETCH_URLS_TOOL_DESCRIPTION =
  'Fetches multiple URLs in parallel and converts them to AI-readable format (JSONL or Markdown). Supports concurrency control and continues on individual failures.';

function extractRejectionMessage({ reason }: PromiseRejectedResult): string {
  return toErrorMessage(reason);
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (hasMessage(reason)) return reason.message;
  return 'Unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasMessage(value: unknown): value is {
  message: string;
} {
  if (!isRecord(value)) return false;
  return typeof value.message === 'string';
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
    return await executeFetchUrls(input);
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

async function executeFetchUrls(
  input: FetchUrlsInput
): Promise<ToolResponseBase> {
  const validUrls = resolveValidUrls(input);
  if (!Array.isArray(validUrls)) return validUrls;

  const batchConfig = buildBatchConfig(input, validUrls.length);
  logDebug('Starting batch URL fetch', {
    urlCount: validUrls.length,
    concurrency: batchConfig.concurrency,
    format: batchConfig.format,
  });

  const processOptions = buildSingleUrlOptions(input, batchConfig.format);
  const results = await collectBatchResults(
    validUrls,
    processOptions,
    batchConfig.concurrency
  );

  if (!batchConfig.continueOnError) {
    const failureResponse = buildBatchFailure(results);
    if (failureResponse) return failureResponse;
  }

  return createBatchResponse(results);
}

function resolveValidUrls(input: FetchUrlsInput): string[] | ToolResponseBase {
  return validateBatchInput(input);
}

function buildBatchConfig(
  input: FetchUrlsInput,
  urlCount: number
): { concurrency: number; continueOnError: boolean; format: Format } {
  return {
    concurrency: normalizeConcurrency(input, urlCount),
    continueOnError: input.continueOnError ?? true,
    format: input.format ?? 'jsonl',
  };
}

function buildSingleUrlOptions(
  input: FetchUrlsInput,
  format: Format
): SingleUrlProcessOptions {
  return {
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
}

function mapSettledResults(
  batch: string[],
  settledResults: PromiseSettledResult<BatchUrlResult>[]
): BatchUrlResult[] {
  return settledResults.map((result, index) =>
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
}

async function collectBatchResults(
  validUrls: string[],
  processOptions: SingleUrlProcessOptions,
  concurrency: number
): Promise<BatchUrlResult[]> {
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

    results.push(...mapSettledResults(batch, settledResults));
  }

  return results;
}

function buildBatchFailure(results: BatchUrlResult[]): ToolResponseBase | null {
  const firstError = results.find((result) => !result.success);
  if (!firstError) return null;
  const errorMsg = firstError.error ?? 'Unknown error';
  return createToolErrorResponse(
    `Batch failed: ${errorMsg}`,
    firstError.url,
    firstError.errorCode ?? 'BATCH_ERROR'
  );
}
