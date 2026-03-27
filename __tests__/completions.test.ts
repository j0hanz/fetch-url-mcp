import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildServerInstructions,
  extractSection,
  filterInstructions,
  HELP_TOPICS,
} from '../src/resources/index.js';

const instructions = buildServerInstructions();

describe('HELP_TOPICS', () => {
  it('contains expected topics', () => {
    assert.deepStrictEqual(
      [...HELP_TOPICS],
      ['capabilities', 'workflows', 'constraints', 'errors']
    );
  });
});

describe('extractSection', () => {
  it('extracts the Capabilities section', () => {
    const section = extractSection(instructions, 'capabilities');
    assert.ok(section, 'section not found');
    assert.ok(section.startsWith('# Capabilities'));
    assert.ok(section.includes('fetch-url'));
    assert.ok(!section.includes('# Workflows'));
  });

  it('extracts the Workflows section', () => {
    const section = extractSection(instructions, 'workflows');
    assert.ok(section, 'section not found');
    assert.ok(section.startsWith('# Workflows'));
    assert.ok(section.includes('Standard'));
    assert.ok(!section.includes('# Errors'));
  });

  it('extracts the Constraints section', () => {
    const section = extractSection(instructions, 'constraints');
    assert.ok(section, 'section not found');
    assert.ok(section.startsWith('# Constraints'));
    assert.ok(section.includes('Blocked URLs'));
  });

  it('extracts the Errors section', () => {
    const section = extractSection(instructions, 'errors');
    assert.ok(section, 'section not found');
    assert.ok(section.startsWith('# Errors'));
    assert.ok(section.includes('VALIDATION_ERROR'));
  });
});

describe('filterInstructions', () => {
  it('returns full instructions when no topic is given', () => {
    assert.strictEqual(filterInstructions(instructions), instructions);
    assert.strictEqual(
      filterInstructions(instructions, undefined),
      instructions
    );
  });

  it('returns full instructions for empty string', () => {
    assert.strictEqual(filterInstructions(instructions, ''), instructions);
  });

  it('returns full instructions for unknown topic', () => {
    assert.strictEqual(
      filterInstructions(instructions, 'nonexistent'),
      instructions
    );
  });

  it('filters to the matching section for valid topic', () => {
    const result = filterInstructions(instructions, 'errors');
    assert.ok(result.startsWith('# Errors'));
    assert.ok(!result.includes('# Capabilities'));
  });

  it('is case-insensitive', () => {
    const result = filterInstructions(instructions, 'ERRORS');
    assert.ok(result.startsWith('# Errors'));
  });

  it('trims whitespace from topic', () => {
    const result = filterInstructions(instructions, '  workflows  ');
    assert.ok(result.startsWith('# Workflows'));
  });
});

describe('buildServerInstructions completions mention', () => {
  it('mentions completions in capabilities section', () => {
    assert.ok(instructions.includes('Completions:'));
    assert.ok(instructions.includes('auto-completion'));
  });

  it('lists all help topics', () => {
    for (const topic of HELP_TOPICS) {
      assert.ok(
        instructions.includes(topic),
        `instructions should mention topic "${topic}"`
      );
    }
  });
});
