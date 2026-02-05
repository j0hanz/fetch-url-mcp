import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FetchError } from '../dist/errors.js';
import { readResponseText } from '../dist/fetch.js';

function createStreamResponse(text: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

describe('readResponseText', () => {
  it('reads text and size from responses', async () => {
    const response = new Response('hello', {
      status: 200,
      headers: { 'content-length': '5' },
    });

    const result = await readResponseText(response, 'https://example.com', 10);

    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('does not error when Content-Length exceeds limit, but truncates if body is larger', async () => {
    const response = new Response('hello', {
      status: 200,
      headers: { 'content-length': '100' },
    });

    const result = await readResponseText(response, 'https://example.com', 10);
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('truncates streamed responses that exceed the byte limit', async () => {
    const response = createStreamResponse('hello world');

    const result = await readResponseText(response, 'https://example.com', 5);
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('returns an abort error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const response = createStreamResponse('hello');

    await assert.rejects(
      () =>
        readResponseText(
          response,
          'https://example.com',
          1024,
          controller.signal
        ),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 499);
        assert.equal(error.message, 'Request was aborted during response read');
        return true;
      }
    );
  });

  it('handles responses without a body stream', async () => {
    const response = new Response(null, { status: 204 });

    const result = await readResponseText(response, 'https://example.com', 10);

    assert.equal(result.text, '');
    assert.equal(result.size, 0);
  });

  it('decodes non-UTF8 content when encoding is provided', async () => {
    // 0xE9 is 'é' in iso-8859-1
    const buffer = new Uint8Array([0xe9]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-length': '1' },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      10,
      undefined,
      'iso-8859-1'
    );

    assert.equal(result.text, 'é');
  });

  it('defaults to UTF-8 without encoding, producing replacement chars for invalid sequences', async () => {
    // 0xE9 is invalid in UTF-8 start byte
    const buffer = new Uint8Array([0xe9]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-length': '1' },
    });

    const result = await readResponseText(response, 'https://example.com', 10);

    // \ufffd is the replacement character
    assert.equal(result.text, '\ufffd');
  });

  it('falls back to UTF-8 when an invalid encoding label is provided', async () => {
    // 0xE9 is invalid in UTF-8 start byte
    const buffer = new Uint8Array([0xe9]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-length': '1' },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      10,
      undefined,
      'unknown-charset'
    );

    // \ufffd is the replacement character
    assert.equal(result.text, '\ufffd');
  });

  it('allows responses with unhandled Content-Encoding header by ignoring it', async () => {
    // 0x1f 0x8b 0x08 is gzip magic number
    const buffer = new Uint8Array([0x1f, 0x8b, 0x08]);
    const response = new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
      },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      10000
    );
    // It should not throw. Content will be garbage (decoded bytes) but that is expected if fetch didn't decompress.
    assert.ok(result.text.length > 0);
  });

  it('allows responses with identity Content-Encoding', async () => {
    const response = new Response('hello', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-encoding': 'identity',
      },
    });

    const result = await readResponseText(response, 'https://example.com', 10);
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('rejects binary content disguised as text', async () => {
    // JFIF magic bytes for JPEG
    const buffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const response = new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'text/plain',
      },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/image.jpg', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('detects UTF-16LE via BOM and avoids false binary detection', async () => {
    const text = 'Hello world';
    const utf16Body = Buffer.from(text, 'utf16le');
    const bomPrefixed = new Uint8Array([0xff, 0xfe, ...utf16Body]);
    const response = new Response(bomPrefixed, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    const result = await readResponseText(response, 'https://example.com', 4096);
    assert.equal(result.text.replace(/^\ufeff/, ''), text);
  });

  it('detects HTML-declared charset when content-type charset is missing', async () => {
    const html = '<meta charset="windows-1252"><p>caf\xe9</p>';
    const bytes = new Uint8Array([...html].map((char) => char.charCodeAt(0)));
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    const result = await readResponseText(response, 'https://example.com', 4096);
    assert.match(result.text, /café/);
  });
});
