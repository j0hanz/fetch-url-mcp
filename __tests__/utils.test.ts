import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CodedError,
  FetchError,
  getErrorMessage,
  isAbortError,
  isError,
  isSystemError,
  toError,
} from '../src/lib/error/index.js';
import {
  CharCode,
  composeAbortSignal,
  getUtf8ByteLength,
  isAsciiOnly,
  isObject,
  isWhitespaceChar,
  timingSafeEqualUtf8,
  trimDanglingTagFragment,
  trimUtf8Buffer,
  truncateToUtf8Boundary,
} from '../src/lib/utils.js';

// ── FetchError ──────────────────────────────────────────────────────

describe('FetchError', () => {
  it('creates error with url, statusCode, and details', () => {
    const err = new FetchError('Not Found', 'https://example.com', 404, {
      custom: true,
    });
    assert.equal(err.message, 'Not Found');
    assert.equal(err.url, 'https://example.com');
    assert.equal(err.statusCode, 404);
    assert.equal(err.name, 'FetchError');
    assert.equal(err.details['custom'], true);
    assert.equal(err.code, 'HTTP_404');
  });

  it('defaults to 502 status when not provided', () => {
    const err = new FetchError('Failed', 'https://example.com');
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, 'FETCH_ERROR');
  });

  it('uses explicit code from details', () => {
    const err = new FetchError('Blocked', 'https://example.com', 403, {
      code: 'EBLOCKED',
    });
    assert.equal(err.code, 'EBLOCKED');
  });

  it('is an instance of Error', () => {
    const err = new FetchError('test', 'https://example.com');
    assert.ok(err instanceof Error);
  });
});

// ── getErrorMessage ────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('returns message from Error', () => {
    assert.equal(getErrorMessage(new Error('test')), 'test');
  });

  it('returns string as-is', () => {
    assert.equal(getErrorMessage('direct message'), 'direct message');
  });

  it('returns Unknown error for null', () => {
    assert.equal(getErrorMessage(null), 'Unknown error');
  });

  it('returns Unknown error for undefined', () => {
    assert.equal(getErrorMessage(undefined), 'Unknown error');
  });

  it('handles object with message property', () => {
    assert.equal(getErrorMessage({ message: 'obj msg' }), 'obj msg');
  });
});

// ── toError ────────────────────────────────────────────────────────

describe('toError', () => {
  it('returns Error as-is', () => {
    const err = new Error('test');
    assert.equal(toError(err), err);
  });

  it('wraps non-Error in Error', () => {
    const result = toError('string error');
    assert.ok(result instanceof Error);
    assert.equal(result.message, 'string error');
  });
});

// ── isAbortError ───────────────────────────────────────────────────

describe('isAbortError', () => {
  it('returns true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.equal(isAbortError(err), true);
  });

  it('returns false for regular Error', () => {
    assert.equal(isAbortError(new Error('test')), false);
  });

  it('returns false for non-errors', () => {
    assert.equal(isAbortError('not an error'), false);
    assert.equal(isAbortError(null), false);
  });
});

// ── isSystemError ──────────────────────────────────────────────────

describe('isSystemError', () => {
  it('returns true for error with code property', () => {
    const err = new CodedError('test', 'ENOENT');
    assert.equal(isSystemError(err), true);
  });

  it('returns false for regular Error', () => {
    assert.equal(isSystemError(new Error('test')), false);
  });

  it('returns false for non-errors', () => {
    assert.equal(isSystemError(42), false);
  });
});

// ── CodedError ─────────────────────────────────────────────────────

describe('CodedError', () => {
  it('creates Error with code property', () => {
    const err = new CodedError('not found', 'ENOENT');
    assert.equal(err.message, 'not found');
    assert.equal(err.code, 'ENOENT');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'CodedError');
  });
});

// ── isObject ────────────────────────────────────────────────────────

describe('isObject', () => {
  it('returns true for plain objects', () => {
    assert.equal(isObject({}), true);
    assert.equal(isObject({ a: 1 }), true);
  });

  it('returns false for arrays', () => {
    assert.equal(isObject([]), false);
  });

  it('returns false for null', () => {
    assert.equal(isObject(null), false);
  });

  it('returns false for primitives', () => {
    assert.equal(isObject('string'), false);
    assert.equal(isObject(42), false);
  });
});

// ── isError ─────────────────────────────────────────────────────────

describe('isError', () => {
  it('returns true for Error instances', () => {
    assert.equal(isError(new Error('test')), true);
    assert.equal(isError(new TypeError('test')), true);
  });

  it('returns false for non-errors', () => {
    assert.equal(isError({ message: 'fake' }), false);
    assert.equal(isError('not an error'), false);
  });
});

// ── composeAbortSignal ──────────────────────────────────────────────

describe('composeAbortSignal', () => {
  it('returns undefined when both args are undefined', () => {
    assert.equal(composeAbortSignal(undefined, undefined), undefined);
  });

  it('returns signal when no timeout', () => {
    const controller = new AbortController();
    const result = composeAbortSignal(controller.signal, undefined);
    assert.equal(result, controller.signal);
  });

  it('returns timeout signal when no user signal', () => {
    const result = composeAbortSignal(undefined, 60000);
    assert.ok(result !== undefined);
  });

  it('returns undefined for zero timeout and no signal', () => {
    assert.equal(composeAbortSignal(undefined, 0), undefined);
  });
});

// ── trimDanglingTagFragment ────────────────────────────────────────

describe('trimDanglingTagFragment', () => {
  it('trims unclosed tag at end', () => {
    const result = trimDanglingTagFragment('<p>Hello</p><div');
    assert.equal(result, '<p>Hello</p>');
  });

  it('trims unclosed closing tag at end', () => {
    const result = trimDanglingTagFragment('<p>Hello</p></di');
    assert.equal(result, '<p>Hello</p>');
  });

  it('preserves valid HTML', () => {
    const html = '<p>Hello</p>';
    assert.equal(trimDanglingTagFragment(html), html);
  });

  it('trims dangling HTML entity', () => {
    const result = trimDanglingTagFragment('Hello &amp');
    assert.equal(result, 'Hello ');
  });

  it('preserves complete entity', () => {
    const html = 'Hello &amp; world';
    assert.equal(trimDanglingTagFragment(html), html);
  });
});

// ── isAsciiOnly ────────────────────────────────────────────────────

describe('isAsciiOnly', () => {
  it('returns true for ASCII-only string', () => {
    assert.equal(isAsciiOnly('Hello world 123'), true);
  });

  it('returns false for string with non-ASCII', () => {
    assert.equal(isAsciiOnly('Héllo'), false);
  });

  it('returns true for empty string', () => {
    assert.equal(isAsciiOnly(''), true);
  });
});

// ── getUtf8ByteLength ──────────────────────────────────────────────

describe('getUtf8ByteLength', () => {
  it('returns correct length for ASCII', () => {
    assert.equal(getUtf8ByteLength('hello'), 5);
  });

  it('returns correct length for multi-byte characters', () => {
    assert.ok(getUtf8ByteLength('€') > 1);
    assert.ok(getUtf8ByteLength('日本語') > 3);
  });
});

// ── trimUtf8Buffer ─────────────────────────────────────────────────

describe('trimUtf8Buffer', () => {
  it('returns buffer as-is if under limit', () => {
    const buf = new TextEncoder().encode('hello');
    const result = trimUtf8Buffer(buf, 100);
    assert.equal(result.length, buf.length);
  });

  it('trims to safe UTF-8 boundary', () => {
    const buf = new TextEncoder().encode('Hello 日本語');
    const result = trimUtf8Buffer(buf, 8);
    // Must not split a multi-byte sequence
    const decoded = new TextDecoder().decode(result);
    assert.ok(decoded.length <= 8);
    assert.ok(!decoded.includes('�'), 'No replacement characters');
  });
});

// ── truncateToUtf8Boundary ─────────────────────────────────────────

describe('truncateToUtf8Boundary', () => {
  it('truncates HTML to byte limit', () => {
    const html = '<p>Hello 日本語 world</p>';
    const result = truncateToUtf8Boundary(html, 20);
    assert.ok(result.length <= html.length);
    assert.ok(!result.includes('�'));
  });
});

// ── timingSafeEqualUtf8 ────────────────────────────────────────────

describe('timingSafeEqualUtf8', () => {
  it('returns true for equal strings', () => {
    assert.equal(timingSafeEqualUtf8('secret', 'secret'), true);
  });

  it('returns false for different strings', () => {
    assert.equal(timingSafeEqualUtf8('secret', 'other'), false);
  });

  it('returns false for different length strings', () => {
    assert.equal(timingSafeEqualUtf8('short', 'longer'), false);
  });
});

// ── isWhitespaceChar ───────────────────────────────────────────────

describe('isWhitespaceChar', () => {
  it('returns true for space', () => {
    assert.equal(isWhitespaceChar(CharCode.SPACE), true);
  });

  it('returns true for tab', () => {
    assert.equal(isWhitespaceChar(CharCode.TAB), true);
  });

  it('returns true for newline', () => {
    assert.equal(isWhitespaceChar(CharCode.LF), true);
  });

  it('returns true for carriage return', () => {
    assert.equal(isWhitespaceChar(CharCode.CR), true);
  });

  it('returns false for letter', () => {
    assert.equal(isWhitespaceChar(CharCode.A_UPPER), false);
  });
});
