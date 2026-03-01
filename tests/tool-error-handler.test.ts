import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createToolErrorResponse,
  handleToolError,
} from '../dist/lib/mcp-tools.js';
import { FetchError } from '../dist/lib/utils.js';
import { createErrorWithCode } from '../dist/lib/utils.js';

describe('tool error responses', () => {
  it('wraps structured content for tool errors', () => {
    const response = createToolErrorResponse(
      'Validation failed',
      'https://example.com'
    );

    assert.equal(response.isError, true);
    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.deepEqual(parsed, {
      error: 'Validation failed',
      url: 'https://example.com',
    });
  });

  it('uses validation error message when present', () => {
    const error = createErrorWithCode('Invalid input', 'VALIDATION_ERROR');
    const response = handleToolError(error, 'https://example.com');

    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.equal(parsed.error, 'Invalid input');
  });

  it('uses fetch error message when present', () => {
    const error = new FetchError('Fetch failed', 'https://example.com', 502);
    const response = handleToolError(error, 'https://example.com');

    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.equal(parsed.error, 'Fetch failed');
  });

  it('falls back to default message for generic errors', () => {
    const error = new Error('Boom');
    const response = handleToolError(error, 'https://example.com');

    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.equal(parsed.error, 'Operation failed: Boom');
  });

  it('handles unknown errors with default message', () => {
    const response = handleToolError('oops', 'https://example.com');

    const parsed = JSON.parse((response.content[0] as { text: string })?.text);
    assert.equal(parsed.error, 'Operation failed: Unknown error');
  });
});
