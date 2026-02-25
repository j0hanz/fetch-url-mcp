import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { FetchError } from '../dist/lib/errors.js';
import { readResponseText } from '../dist/lib/fetch.js';

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

function createChunkedStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

function createChunkedBufferResponse(
  chunks: Uint8Array[],
  headers?: HeadersInit
) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers,
  });
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

  it('truncates multi-chunk streams when the limit is reached', async () => {
    const response = createChunkedStreamResponse(['hello ', 'world']);

    const result = await readResponseText(response, 'https://example.com', 7);
    assert.equal(result.text, 'hello w');
    assert.equal(result.size, 7);
  });

  it('aborts when the signal fires during a streaming read', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controllerRef) {
        controllerRef.enqueue(encoder.encode('hello'));
      },
    });

    const response = new Response(stream, { status: 200 });
    const readPromise = readResponseText(
      response,
      'https://example.com',
      1024,
      controller.signal
    );

    await Promise.resolve();
    controller.abort();

    await assert.rejects(
      () => readPromise,
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 499);
        assert.equal(error.message, 'Request was aborted during response read');
        return true;
      }
    );
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

  it('rejects responses with unsupported Content-Encoding', async () => {
    // Use non-binary bytes that don't match any signature
    const buffer = new Uint8Array([0x61, 0x62, 0x63, 0x64]); // "abcd"
    const response = new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-encoding': 'unknown-encoding',
      },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com', 10000),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 415);
        assert.match(error.message, /Unsupported Content-Encoding/i);
        return true;
      }
    );
  });

  it('decodes gzip encoded responses', async () => {
    const compressed = gzipSync(Buffer.from('hello', 'utf-8'));
    const response = new Response(compressed, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
      },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      1024
    );
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('decodes brotli encoded responses', async () => {
    const compressed = brotliCompressSync(Buffer.from('hello', 'utf-8'));
    const response = new Response(compressed, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'br',
      },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      1024
    );
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('decodes responses with multiple content-encoding values in decode order', async () => {
    const gzipped = gzipSync(Buffer.from('hello', 'utf-8'));
    const compressed = brotliCompressSync(gzipped);
    const response = new Response(compressed, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip, br',
      },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      1024
    );
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
  });

  it('falls back to passthrough when declared encoding cannot be decoded', async () => {
    const response = new Response('hello', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-encoding': 'br',
      },
    });

    const result = await readResponseText(response, 'https://example.com', 64);
    assert.equal(result.text, 'hello');
    assert.equal(result.size, 5);
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

  it('rejects binary content detected in later stream chunks', async () => {
    const firstChunk = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // hello
    const secondChunk = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG signature
    const response = createChunkedBufferResponse([firstChunk, secondChunk], {
      'content-type': 'text/plain',
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/late-binary', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects WebP binary (RIFF signature) disguised as text', async () => {
    // RIFF magic bytes (WebP, WAV, AVI)
    const buffer = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/image.webp', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects WebAssembly binary disguised as text', async () => {
    // WASM magic bytes
    const buffer = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/module.wasm', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.statusCode, 500);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects GZIP compressed content', async () => {
    const buffer = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/file.gz', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects RAR archive', async () => {
    const buffer = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/file.rar', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects 7-Zip archive', async () => {
    const buffer = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/file.7z', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects Windows executable', async () => {
    const buffer = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/file.exe', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects WOFF font', async () => {
    const buffer = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0x00]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/font.woff', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
        assert.match(error.message, /binary content detected/);
        return true;
      }
    );
  });

  it('rejects SQLite database', async () => {
    const buffer = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]);
    const response = new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await assert.rejects(
      () => readResponseText(response, 'https://example.com/db.sqlite', 1024),
      (error) => {
        assert.ok(error instanceof FetchError);
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

    const result = await readResponseText(
      response,
      'https://example.com',
      4096
    );
    assert.equal(result.text.replace(/^\ufeff/, ''), text);
  });

  it('detects HTML-declared charset when content-type charset is missing', async () => {
    const html = '<meta charset="windows-1252"><p>caf\xe9</p>';
    const bytes = Buffer.from(html, 'latin1');
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    const result = await readResponseText(
      response,
      'https://example.com',
      4096
    );
    assert.match(result.text, /café/);
  });
});
