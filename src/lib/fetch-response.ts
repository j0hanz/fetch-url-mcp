import { Buffer } from 'node:buffer';
import { PassThrough, Readable, Transform } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { finished, pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { FetchError, toError } from './errors.js';
import {
  decodeBuffer,
  getCharsetFromContentType,
  isBinaryContent,
  resolveEncoding,
} from './fetch-content.js';
import { createFetchError } from './fetch-errors.js';
import { cancelResponseBody, MaxBytesError } from './fetch-redirect.js';
import { toNodeReadableStream, toWebReadableStream } from './fetch-stream.js';
import type { FetchTelemetryContext } from './fetch-telemetry.js';
// ---------------------------------------------------------------------------
// High-level response reading with decode + telemetry
// ---------------------------------------------------------------------------

import type { FetchTelemetry } from './fetch-telemetry.js';
import { logDebug, redactUrl } from './observability.js';
import { isError } from './type-guards.js';

// ---------------------------------------------------------------------------
// Response error resolution
// ---------------------------------------------------------------------------

export function resolveResponseError(
  response: Response,
  finalUrl: string
): FetchError | null {
  if (response.status === 429) {
    return createFetchError(
      { kind: 'rate-limited', retryAfter: response.headers.get('retry-after') },
      finalUrl
    );
  }

  return response.ok
    ? null
    : createFetchError(
        {
          kind: 'http',
          status: response.status,
          statusText: response.statusText,
        },
        finalUrl
      );
}

// ---------------------------------------------------------------------------
// Media-type helpers
// ---------------------------------------------------------------------------

function resolveMediaType(contentType: string | null): string | null {
  if (!contentType) return null;

  const semiIndex = contentType.indexOf(';');
  const mediaType =
    semiIndex === -1 ? contentType : contentType.slice(0, semiIndex);
  const trimmed = mediaType.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

const TEXTUAL_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/markdown',
]);

function isTextLikeMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  if (TEXTUAL_MEDIA_TYPES.has(mediaType)) return true;
  return (
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml') ||
    mediaType.endsWith('+yaml') ||
    mediaType.endsWith('+text') ||
    mediaType.endsWith('+markdown')
  );
}

export function assertSupportedContentType(
  contentType: string | null,
  url: string
): void {
  const mediaType = resolveMediaType(contentType);
  if (!mediaType) {
    logDebug('No Content-Type header; relying on binary-content detection', {
      url: redactUrl(url),
    });
    return;
  }

  if (!isTextLikeMediaType(mediaType)) {
    throw new FetchError(`Unsupported content type: ${mediaType}`, url);
  }
}

// ---------------------------------------------------------------------------
// Content-Encoding decompression
// ---------------------------------------------------------------------------

function extractEncodingTokens(value: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = value.length;

  while (i < len) {
    while (
      i < len &&
      (value.charCodeAt(i) === 44 || value.charCodeAt(i) <= 32)
    ) {
      i += 1;
    }
    if (i >= len) break;

    const start = i;
    while (i < len && value.charCodeAt(i) !== 44) i += 1;

    const token = value.slice(start, i).trim().toLowerCase();
    if (token) tokens.push(token);

    if (i < len && value.charCodeAt(i) === 44) i += 1;
  }

  return tokens;
}

type ContentEncoding = 'gzip' | 'deflate' | 'br';

function parseContentEncodings(value: string | null): string[] | null {
  if (!value) return null;
  const tokens = extractEncodingTokens(value);
  if (tokens.length === 0) return null;
  return tokens;
}

function isSupportedContentEncoding(
  encoding: string
): encoding is ContentEncoding {
  return encoding === 'gzip' || encoding === 'deflate' || encoding === 'br';
}

function createUnsupportedContentEncodingError(
  url: string,
  encodingHeader: string
): FetchError {
  return new FetchError(
    `Unsupported Content-Encoding: ${encodingHeader}`,
    url,
    415,
    {
      reason: 'unsupported_content_encoding',
      encoding: encodingHeader,
    }
  );
}

function createDecompressor(
  encoding: ContentEncoding
):
  | ReturnType<typeof createGunzip>
  | ReturnType<typeof createInflate>
  | ReturnType<typeof createBrotliDecompress> {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
  }
}

function createPumpedStream(
  initialChunk: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (initialChunk && initialChunk.byteLength > 0) {
        controller.enqueue(initialChunk);
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function decodeResponseIfNeeded(
  response: Response,
  url: string,
  signal?: AbortSignal
): Promise<Response> {
  const encodingHeader = response.headers.get('content-encoding');
  const parsedEncodings = parseContentEncodings(encodingHeader);
  if (!parsedEncodings) return response;

  const encodings = parsedEncodings.filter((token) => token !== 'identity');
  if (encodings.length === 0) return response;

  for (const encoding of encodings) {
    if (!isSupportedContentEncoding(encoding)) {
      throw createUnsupportedContentEncodingError(
        url,
        encodingHeader ?? encoding
      );
    }
  }

  if (!response.body) return response;
  const [decodeBranch, passthroughBranch] = response.body.tee();

  const decodeOrder = encodings
    .slice()
    .reverse()
    .filter(isSupportedContentEncoding);

  const decompressors = decodeOrder.map((encoding) =>
    createDecompressor(encoding)
  );
  const decodeSource = Readable.fromWeb(
    toNodeReadableStream(decodeBranch, url, 'response:decode-content-encoding')
  );
  const decodedNodeStream = new PassThrough();
  const decodedPipeline = pipeline([
    decodeSource,
    ...decompressors,
    decodedNodeStream,
  ]);

  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');

  const abortDecodePipeline = (): void => {
    decodeSource.destroy();
    for (const decompressor of decompressors) {
      decompressor.destroy();
    }
    decodedNodeStream.destroy();
  };

  if (signal) {
    signal.addEventListener('abort', abortDecodePipeline, { once: true });
  }

  void decodedPipeline.catch((error: unknown) => {
    decodedNodeStream.destroy(toError(error));
  });

  const decodedBodyStream = toWebReadableStream(
    decodedNodeStream,
    url,
    'response:decode-content-encoding'
  );
  const decodedReader = decodedBodyStream.getReader();

  const clearAbortListener = (): void => {
    if (!signal) return;
    signal.removeEventListener('abort', abortDecodePipeline);
  };

  try {
    const first = await decodedReader.read();
    if (first.done) {
      clearAbortListener();
      void passthroughBranch.cancel().catch(() => undefined);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    void passthroughBranch.cancel().catch(() => undefined);
    const body = createPumpedStream(first.value, decodedReader);

    if (signal) {
      void finished(decodedNodeStream, { cleanup: true })
        .catch(() => {})
        .finally(() => {
          clearAbortListener();
        });
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error: unknown) {
    clearAbortListener();
    abortDecodePipeline();
    void decodedReader.cancel(error).catch(() => undefined);

    logDebug('Content-Encoding decode failed; using passthrough body', {
      url: redactUrl(url),
      encoding: encodingHeader ?? encodings.join(','),
      error: isError(error) ? error.message : String(error),
    });

    return new Response(passthroughBranch, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

// ---------------------------------------------------------------------------
// ResponseTextReader
// ---------------------------------------------------------------------------

export class ResponseTextReader {
  async read(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{ text: string; size: number; truncated: boolean }> {
    const {
      buffer,
      encoding: effectiveEncoding,
      truncated,
    } = await this.readBuffer(response, url, maxBytes, signal, encoding);

    const text = decodeBuffer(buffer, effectiveEncoding);
    return { text, size: buffer.byteLength, truncated };
  }

  async readBuffer(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    if (signal?.aborted) {
      cancelResponseBody(response);
      throw createFetchError({ kind: 'aborted' }, url);
    }

    if (!response.body) {
      return this.readNonStreamBuffer(
        response,
        url,
        maxBytes,
        signal,
        encoding
      );
    }

    return this.readStreamToBuffer(
      response.body,
      url,
      maxBytes,
      signal,
      encoding
    );
  }

  private async readNonStreamBuffer(
    response: Response,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    if (signal?.aborted) throw createFetchError({ kind: 'canceled' }, url);

    const limit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;

    let buffer: Uint8Array;
    let truncated = false;

    try {
      // Try safe blob slicing if available (Node 18+) to avoid OOM
      const blob = await response.blob();
      if (Number.isFinite(limit) && blob.size > limit) {
        const sliced = blob.slice(0, limit);
        buffer = new Uint8Array(await sliced.arrayBuffer());
        truncated = true;
      } else {
        buffer = new Uint8Array(await blob.arrayBuffer());
      }
    } catch {
      // Fallback if blob() fails
      const arrayBuffer = await response.arrayBuffer();
      const length = Math.min(arrayBuffer.byteLength, limit);
      buffer = new Uint8Array(arrayBuffer, 0, length);
      truncated = Number.isFinite(limit) && arrayBuffer.byteLength > limit;
    }

    const effectiveEncoding =
      resolveEncoding(encoding, buffer) ?? encoding ?? 'utf-8';

    if (isBinaryContent(buffer, effectiveEncoding)) {
      throw new FetchError(
        'Detailed content type check failed: binary content detected',
        url,
        500,
        { reason: 'binary_content_detected' }
      );
    }

    return {
      buffer,
      encoding: effectiveEncoding,
      size: buffer.byteLength,
      truncated,
    };
  }

  private async readStreamToBuffer(
    stream: ReadableStream<Uint8Array>,
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: string
  ): Promise<{
    buffer: Uint8Array;
    encoding: string;
    size: number;
    truncated: boolean;
  }> {
    const byteLimit = maxBytes <= 0 ? Number.POSITIVE_INFINITY : maxBytes;
    const captureChunks = byteLimit !== Number.POSITIVE_INFINITY;
    let effectiveEncoding = encoding ?? 'utf-8';
    let encodingResolved = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const source = Readable.fromWeb(
      toNodeReadableStream(stream, url, 'response:read-stream-buffer')
    );

    const guard = new Transform({
      transform(this: Transform, chunk, _encoding, callback): void {
        try {
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                (chunk as Uint8Array).buffer,
                (chunk as Uint8Array).byteOffset,
                (chunk as Uint8Array).byteLength
              );

          if (!encodingResolved) {
            encodingResolved = true;
            effectiveEncoding =
              resolveEncoding(encoding, buf) ?? encoding ?? 'utf-8';
          }

          if (isBinaryContent(buf, effectiveEncoding)) {
            callback(
              new FetchError(
                'Detailed content type check failed: binary content detected',
                url,
                500,
                { reason: 'binary_content_detected' }
              )
            );
            return;
          }

          const newTotal = total + buf.length;
          if (newTotal > byteLimit) {
            const remaining = byteLimit - total;
            if (remaining > 0) {
              const slice = buf.subarray(0, remaining);
              total += remaining;
              if (captureChunks) chunks.push(slice);
              this.push(slice);
            }
            callback(new MaxBytesError());
            return;
          }

          total = newTotal;
          if (captureChunks) chunks.push(buf);
          callback(null, buf);
        } catch (error: unknown) {
          callback(toError(error));
        }
      },
    });

    const guarded = source.pipe(guard);
    const abortHandler = (): void => {
      source.destroy();
      guard.destroy();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const buffer = await consumeBuffer(guarded);
      return {
        buffer,
        encoding: effectiveEncoding,
        size: total,
        truncated: false,
      };
    } catch (error: unknown) {
      if (signal?.aborted) throw createFetchError({ kind: 'aborted' }, url);
      if (error instanceof FetchError) throw error;
      if (error instanceof MaxBytesError) {
        source.destroy();
        guard.destroy();
        return {
          buffer: Buffer.concat(chunks, total),
          encoding: effectiveEncoding,
          size: total,
          truncated: true,
        };
      }
      throw error;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}

type ReadDecodedResponseResult =
  | {
      kind: 'text';
      text: string;
      size: number;
      truncated: boolean;
    }
  | {
      kind: 'buffer';
      buffer: Uint8Array;
      encoding: string;
      size: number;
      truncated: boolean;
    };

export async function readAndRecordDecodedResponse(
  response: Response,
  finalUrl: string,
  ctx: FetchTelemetryContext,
  telemetry: FetchTelemetry,
  reader: ResponseTextReader,
  maxBytes: number,
  mode: 'text' | 'buffer',
  signal?: AbortSignal
): Promise<ReadDecodedResponseResult> {
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const decodedResponse = await decodeResponseIfNeeded(
    response,
    finalUrl,
    signal
  );

  const contentType = decodedResponse.headers.get('content-type');
  assertSupportedContentType(contentType, finalUrl);

  const declaredEncoding = getCharsetFromContentType(contentType ?? null);

  if (mode === 'text') {
    const { text, size, truncated } = await reader.read(
      decodedResponse,
      finalUrl,
      maxBytes,
      signal,
      declaredEncoding
    );
    telemetry.recordResponse(ctx, decodedResponse, size);
    return { kind: 'text', text, size, truncated };
  }

  const { buffer, encoding, size, truncated } = await reader.readBuffer(
    decodedResponse,
    finalUrl,
    maxBytes,
    signal,
    declaredEncoding
  );
  telemetry.recordResponse(ctx, decodedResponse, size);
  return { kind: 'buffer', buffer, encoding, size, truncated };
}
