import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { describe, it } from 'node:test';

import {
  endTransformStage,
  startTransformStage,
  type TransformStageEvent,
} from '../dist/transform.js';

describe('transform telemetry', () => {
  it('redacts query and fragment from the URL', () => {
    const channel = diagnosticsChannel.channel('superfetch.transform');
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
});
