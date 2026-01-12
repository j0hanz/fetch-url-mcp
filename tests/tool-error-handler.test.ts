import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FetchError } from '../dist/errors.js';
import { createErrorWithCode } from '../dist/errors.js';
import { createToolErrorResponse, handleToolError } from '../dist/tools.js';

describe('tool error responses', () => {
  it('wraps structured content for tool errors', () => {
    const response = createToolErrorResponse(
      'Validation failed',
      'https://example.com'
    );

    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent, {
      error: 'Validation failed',
      url: 'https://example.com',
    });
    assert.equal(
      response.content[0]?.text,
      JSON.stringify(response.structuredContent)
    );
  });

  it('uses validation error message when present', () => {
    const error = createErrorWithCode('Invalid input', 'VALIDATION_ERROR');
    const response = handleToolError(error, 'https://example.com');

    assert.equal(response.structuredContent.error, 'Invalid input');
  });

  it('uses fetch error message when present', () => {
    const error = new FetchError('Fetch failed', 'https://example.com', 502);
    const response = handleToolError(error, 'https://example.com');

    assert.equal(response.structuredContent.error, 'Fetch failed');
  });

  it('falls back to default message for generic errors', () => {
    const error = new Error('Boom');
    const response = handleToolError(error, 'https://example.com');

    assert.equal(response.structuredContent.error, 'Operation failed: Boom');
  });

  it('handles unknown errors with default message', () => {
    const response = handleToolError('oops', 'https://example.com');

    assert.equal(
      response.structuredContent.error,
      'Operation failed: Unknown error'
    );
  });
});
