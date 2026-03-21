import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import type { SharedFetchStage } from '../lib/fetch-pipeline.js';
import type { ProgressReporter } from '../lib/progress.js';
import { isObject } from '../lib/utils.js';

type FetchPath = 'unknown' | 'cache_hit' | 'cache_miss';

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
  private path: FetchPath = 'unknown';

  constructor(
    private readonly reporter: ProgressReporter,
    private readonly context: string
  ) {}

  reportStart(): void {
    this.reporter.report(1, 'Preparing request');
  }

  reportStage(stage: SharedFetchStage): void {
    const mapped = this.mapStage(stage);
    if (!mapped) return;
    this.reporter.report(mapped.step, mapped.message);
  }

  reportSuccess(contentSize: number): void {
    this.reporter.report(8, buildFetchSuccessSummary(contentSize));
  }

  reportFailure(cancelled: boolean): void {
    this.reporter.report(8, cancelled ? 'Cancelled' : 'Failed');
  }

  private mapStage(
    stage: SharedFetchStage
  ): { step: number; message: string } | undefined {
    switch (stage) {
      case 'resolve_url':
        return { step: 2, message: 'Resolving URL' };
      case 'check_cache':
        return { step: 3, message: 'Checking cache' };
      case 'cache_hit':
        this.path = 'cache_hit';
        return { step: 4, message: 'Loaded from cache' };
      case 'cache_restore':
        this.path = 'cache_hit';
        return { step: 5, message: 'Restoring cached content' };
      case 'fetch_remote':
        this.path = 'cache_miss';
        return { step: 4, message: `Fetching ${this.context}` };
      case 'response_ready':
        this.path = 'cache_miss';
        return { step: 5, message: 'Received response' };
      case 'transform_start':
        this.path = 'cache_miss';
        return { step: 6, message: 'Parsing HTML -> Markdown' };
      case 'prepare_output':
        return {
          step: this.path === 'cache_miss' ? 7 : 6,
          message: 'Fetch completed',
        };
      case 'finalize_output':
        if (this.path === 'cache_miss') return undefined;
        return { step: 7, message: 'Finalizing output' };
    }
  }
}
