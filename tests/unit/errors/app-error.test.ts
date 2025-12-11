import { describe, expect, test } from 'vitest';

import {
  AppError,
  FetchError,
  RateLimitError,
  TimeoutError,
  UrlValidationError,
  ValidationError,
} from '../../../src/errors/app-error.js';

describe('app-error', () => {
  describe('AppError', () => {
    test('creates error with default values', () => {
      const error = new AppError('Test error');

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.isOperational).toBe(true);
      expect(error.name).toBe('AppError');
    });

    test('creates error with custom values', () => {
      const error = new AppError('Custom error', 400, 'CUSTOM_CODE', false);

      expect(error.message).toBe('Custom error');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('CUSTOM_CODE');
      expect(error.isOperational).toBe(false);
    });

    test('has stack trace', () => {
      const error = new AppError('Test error');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('AppError');
    });
  });

  describe('ValidationError', () => {
    test('creates validation error with default status', () => {
      const error = new ValidationError('Invalid input');

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Invalid input');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.isOperational).toBe(true);
      expect(error.details).toBeUndefined();
    });

    test('creates validation error with details', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const error = new ValidationError('Invalid email', details);

      expect(error.details).toEqual(details);
      expect(error.message).toBe('Invalid email');
    });

    test('is instance of Error', () => {
      const error = new ValidationError('Test');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(ValidationError);
    });
  });

  describe('UrlValidationError', () => {
    test('creates URL validation error', () => {
      const error = new UrlValidationError('Invalid URL', 'http://invalid.url');

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Invalid URL');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('INVALID_URL');
      expect(error.url).toBe('http://invalid.url');
    });

    test('stores URL property', () => {
      const url = 'http://localhost:8080';
      const error = new UrlValidationError('Blocked URL', url);

      expect(error.url).toBe(url);
    });
  });

  describe('FetchError', () => {
    test('creates fetch error without HTTP status', () => {
      const error = new FetchError('Network error', 'http://example.com');

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Network error');
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe('FETCH_ERROR');
      expect(error.url).toBe('http://example.com');
      expect(error.httpStatus).toBeUndefined();
    });

    test('creates fetch error with HTTP status', () => {
      const error = new FetchError('Not found', 'http://example.com', 404);

      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.httpStatus).toBe(404);
      expect(error.url).toBe('http://example.com');
    });

    test('creates fetch error with 500 status', () => {
      const error = new FetchError('Server error', 'http://example.com', 500);

      expect(error.statusCode).toBe(500);
      expect(error.httpStatus).toBe(500);
    });
  });

  describe('RateLimitError', () => {
    test('creates rate limit error', () => {
      const error = new RateLimitError(60);

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Too many requests');
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryAfter).toBe(60);
    });

    test('stores retryAfter value', () => {
      const error = new RateLimitError(120);

      expect(error.retryAfter).toBe(120);
    });
  });

  describe('TimeoutError', () => {
    test('creates timeout error as request timeout', () => {
      const error = new TimeoutError(5000, false);

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toBe('Request timeout after 5000ms');
      expect(error.statusCode).toBe(408);
      expect(error.code).toBe('TIMEOUT');
      expect(error.timeoutMs).toBe(5000);
    });

    test('creates timeout error as gateway timeout', () => {
      const error = new TimeoutError(30000, true);

      expect(error.message).toBe('Request timeout after 30000ms');
      expect(error.statusCode).toBe(504);
      expect(error.code).toBe('TIMEOUT');
      expect(error.timeoutMs).toBe(30000);
    });

    test('stores timeout value', () => {
      const error = new TimeoutError(15000);

      expect(error.timeoutMs).toBe(15000);
    });
  });

  describe('Error Inheritance', () => {
    test('all custom errors inherit from AppError', () => {
      const validationError = new ValidationError('test');
      const urlError = new UrlValidationError('test', 'url');
      const fetchError = new FetchError('test', 'url');
      const rateLimitError = new RateLimitError(60);
      const timeoutError = new TimeoutError(5000);

      expect(validationError).toBeInstanceOf(AppError);
      expect(urlError).toBeInstanceOf(AppError);
      expect(fetchError).toBeInstanceOf(AppError);
      expect(rateLimitError).toBeInstanceOf(AppError);
      expect(timeoutError).toBeInstanceOf(AppError);
    });

    test('all custom errors inherit from Error', () => {
      const validationError = new ValidationError('test');
      const urlError = new UrlValidationError('test', 'url');
      const fetchError = new FetchError('test', 'url');
      const rateLimitError = new RateLimitError(60);
      const timeoutError = new TimeoutError(5000);

      expect(validationError).toBeInstanceOf(Error);
      expect(urlError).toBeInstanceOf(Error);
      expect(fetchError).toBeInstanceOf(Error);
      expect(rateLimitError).toBeInstanceOf(Error);
      expect(timeoutError).toBeInstanceOf(Error);
    });
  });
});
