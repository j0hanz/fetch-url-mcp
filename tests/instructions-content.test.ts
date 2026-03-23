import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildServerInstructions } from '../dist/resources/index.js';

describe('Server instructions content', () => {
  it('does not reference removed skipNoiseRemoval parameter', () => {
    const instructions = buildServerInstructions();
    assert.ok(
      !instructions.includes('skipNoiseRemoval'),
      'Instructions should not mention skipNoiseRemoval'
    );
  });

  it('does not reference removed Full-Fidelity workflow', () => {
    const instructions = buildServerInstructions();
    assert.ok(
      !instructions.includes('Full-Fidelity'),
      'Instructions should not mention Full-Fidelity workflow'
    );
  });

  it('does not reference removed maxInlineChars parameter', () => {
    const instructions = buildServerInstructions();
    assert.ok(
      !instructions.includes('maxInlineChars'),
      'Instructions should not mention maxInlineChars'
    );
  });

  it('does not claim forceRefresh removes truncation limits', () => {
    const instructions = buildServerInstructions();
    assert.ok(
      !instructions.includes('retry with `forceRefresh: true`'),
      'Instructions should not promise forceRefresh as a truncation escape hatch'
    );
  });
});
