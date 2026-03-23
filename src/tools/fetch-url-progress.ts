import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import type { SharedFetchStage } from '../lib/fetch-pipeline.js';
import type { ProgressReporter } from '../lib/progress.js';
import { isObject } from '../lib/utils.js';

type CacheStatus = 'unknown' | 'cache_hit' | 'cache_miss';

const Step = {
  START: 1,
  RESOLVE_URL: 2,
  CHECK_CACHE: 3,
  CACHE_OR_FETCH: 4,
  RESTORE_OR_RESPONSE: 5,
  TRANSFORM: 6,
  PREPARE: 7,
  DONE: 8,
} as const;

function formatContentSize(contentSize: number): string {
  if (contentSize < 1000) return `${contentSize} chars`;
  if (contentSize < 1_000_000) return `${(contentSize / 1024).toFixed(1)} KB`;
  return `${(contentSize / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFetchSuccessSummary(contentSize: number): string {
  return `Done — ${formatContentSize(contentSize)}`;
}

export function getFetchCompletionStatusMessage(
  result: ServerResult
): string | undefined {
  if (!isObject(result)) return undefined;

  const { structuredContent } = result as { structuredContent?: unknown };
  if (!isObject(structuredContent)) return undefined;

  const { contentSize } = structuredContent;
  return typeof contentSize === 'number'
    ? buildFetchSuccessSummary(contentSize)
    : undefined;
}

export class FetchUrlProgressPlan {
  private cacheStatus: CacheStatus = 'unknown';

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly context: string
  ) {}

  reportStart(): void {
    this.reporter.report(Step.START, 'Preparing request');
  }

  reportStage(stage: SharedFetchStage): void {
    const mapped = this.mapStage(stage);
    if (!mapped) return;
    this.reporter.report(mapped.step, mapped.message);
  }

  reportSuccess(contentSize: number): void {
    this.reporter.report(Step.DONE, buildFetchSuccessSummary(contentSize));
  }

  reportFailure(cancelled: boolean): void {
    this.reporter.report(Step.DONE, cancelled ? 'Cancelled' : 'Failed');
  }

  private mapStage(
    stage: SharedFetchStage
  ): { step: number; message: string } | undefined {
    switch (stage) {
      case 'resolve_url':
        return { step: Step.RESOLVE_URL, message: 'Resolving URL' };
      case 'check_cache':
        return { step: Step.CHECK_CACHE, message: 'Checking cache' };
      case 'cache_hit':
        this.cacheStatus = 'cache_hit';
        return { step: Step.CACHE_OR_FETCH, message: 'Loaded from cache' };
      case 'cache_restore':
        this.cacheStatus = 'cache_hit';
        return {
          step: Step.RESTORE_OR_RESPONSE,
          message: 'Restoring cached content',
        };
      case 'fetch_remote':
        this.cacheStatus = 'cache_miss';
        return {
          step: Step.CACHE_OR_FETCH,
          message: `Fetching ${this.context}`,
        };
      case 'response_ready':
        this.cacheStatus = 'cache_miss';
        return { step: Step.RESTORE_OR_RESPONSE, message: 'Received response' };
      case 'transform_start':
        this.cacheStatus = 'cache_miss';
        return { step: Step.TRANSFORM, message: 'Parsing HTML -> Markdown' };
      case 'prepare_output':
        return {
          step:
            this.cacheStatus === 'cache_miss' ? Step.PREPARE : Step.TRANSFORM,
          message: 'Fetch completed',
        };
      case 'finalize_output':
        if (this.cacheStatus === 'cache_miss') return undefined;
        return { step: Step.PREPARE, message: 'Finalizing output' };
    }
  }
}
