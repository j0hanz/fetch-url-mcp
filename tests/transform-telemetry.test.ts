import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { describe, it } from 'node:test';

import {
  endTransformStage,
  startTransformStage,
} from '../dist/transform/transform.js';
import type { TransformStageEvent } from '../dist/transform/types.js';

type StageBudget = {
  totalBudgetMs: number;
  elapsedMs: number;
};

describe('transform telemetry', () => {
  it('redacts query and fragment from the URL', () => {
    const channel = diagnosticsChannel.channel('fetch-url-mcp.transform');
    const events: TransformStageEvent[] = [];
    const subscriber = (event: unknown) => {
      events.push(event as TransformStageEvent);
    };

    channel.subscribe(subscriber);
    try {
      const ctx = startTransformStage('https://example.com/path?x=1#y', 'test');
      endTransformStage(ctx);
    } finally {
      channel.unsubscribe(subscriber);
    }

    assert.equal(events.length, 1);
    assert.equal(events[0]?.url, 'https://example.com/path');
  });

  it('startTransformStage accepts budget and tracks remaining budget', () => {
    const channel = diagnosticsChannel.channel('fetch-url-mcp.transform');
    const events: TransformStageEvent[] = [];
    const subscriber = (event: unknown) => {
      events.push(event as TransformStageEvent);
    };

    const budget: StageBudget = { totalBudgetMs: 1000, elapsedMs: 200 };

    channel.subscribe(subscriber);
    try {
      const ctx = startTransformStage('https://example.com', 'test', budget);
      assert.ok(ctx, 'context should be created');
      assert.equal(ctx.budgetMs, 800, 'remaining budget should be 800ms');
      assert.equal(ctx.totalBudgetMs, 1000, 'total budget should be preserved');
      endTransformStage(ctx);
    } finally {
      channel.unsubscribe(subscriber);
    }

    assert.equal(events.length, 1);
  });

  it('endTransformStage returns duration in milliseconds', () => {
    const channel = diagnosticsChannel.channel('fetch-url-mcp.transform');
    const subscriber = () => {};

    channel.subscribe(subscriber);
    try {
      const ctx = startTransformStage('https://example.com', 'test');
      const duration = endTransformStage(ctx);
      assert.equal(typeof duration, 'number');
      assert.ok(duration >= 0, 'duration should be non-negative');
    } finally {
      channel.unsubscribe(subscriber);
    }
  });
});
