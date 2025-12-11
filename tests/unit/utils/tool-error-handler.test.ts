import { describe, expect, test } from 'vitest';

import {
  AppError,
  FetchError,
  TimeoutError,
  UrlValidationError,
} from '../../../src/errors/app-error.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../../src/utils/tool-error-handler.js';

describe('tool-error-handler', () => {
  describe('createToolErrorResponse', () => {
    test('creates structured error response', () => {
      const result = createToolErrorResponse(
        'Test error',
        'http://example.com',
        'TEST_CODE'
      );

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Test error');
      expect(parsed.url).toBe('http://example.com');
      expect(parsed.errorCode).toBe('TEST_CODE');
    });

    test('structured content matches content text', () => {
      const result = createToolErrorResponse(
        'Error message',
        'http://test.com',
        'ERROR_CODE'
      );

      const parsedContent = JSON.parse(result.content[0].text);
      expect(parsedContent).toEqual(result.structuredContent);
    });

    test('handles empty URL', () => {
      const result = createToolErrorResponse(
        'No URL provided',
        '',
        'MISSING_URL'
      );

      expect(result.structuredContent.url).toBe('');
      expect(result.structuredContent.error).toBe('No URL provided');
    });
  });

  describe('handleToolError', () => {
    test('handles UrlValidationError', () => {
      const error = new UrlValidationError(
        'Invalid URL format',
        'http://localhost'
      );
      const result = handleToolError(error, 'http://localhost');

      expect(result.isError).toBe(true);
      expect(result.structuredContent.errorCode).toBe('INVALID_URL');
      expect(result.structuredContent.error).toBe('Invalid URL format');
      expect(result.structuredContent.url).toBe('http://localhost');
    });

    test('handles TimeoutError', () => {
      const error = new TimeoutError(5000, true);
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('TIMEOUT');
      expect(result.structuredContent.error).toContain('5000ms');
    });

    test('handles FetchError without HTTP status', () => {
      const error = new FetchError('Network error', 'http://example.com');
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('FETCH_ERROR');
      expect(result.structuredContent.error).toBe('Network error');
    });

    test('handles FetchError with HTTP status', () => {
      const error = new FetchError('Not Found', 'http://example.com', 404);
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('HTTP_404');
      expect(result.structuredContent.error).toBe('Not Found');
    });

    test('handles FetchError with 500 status', () => {
      const error = new FetchError('Server Error', 'http://example.com', 500);
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('HTTP_500');
    });

    test('handles generic AppError', () => {
      const error = new AppError('Custom error', 400, 'CUSTOM_CODE');
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('CUSTOM_CODE');
      expect(result.structuredContent.error).toBe('Custom error');
    });

    test('handles standard Error', () => {
      const error = new Error('Standard error');
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('UNKNOWN_ERROR');
      expect(result.structuredContent.error).toContain('Standard error');
    });

    test('handles unknown error type', () => {
      const error = { message: 'Unknown error' };
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('UNKNOWN_ERROR');
      expect(result.structuredContent.error).toContain('Unknown error');
    });

    test('handles non-error primitive', () => {
      const result = handleToolError('string error', 'http://example.com');

      expect(result.structuredContent.errorCode).toBe('UNKNOWN_ERROR');
      expect(result.structuredContent.error).toContain('Unknown error');
    });

    test('uses fallback message', () => {
      const error = new Error('Test');
      const result = handleToolError(
        error,
        'http://example.com',
        'Custom fallback'
      );

      expect(result.structuredContent.error).toContain('Custom fallback');
      expect(result.structuredContent.error).toContain('Test');
    });

    test('default fallback message', () => {
      const error = new Error('Test');
      const result = handleToolError(error, 'http://example.com');

      expect(result.structuredContent.error).toContain('Operation failed');
    });
  });
});
