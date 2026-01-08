import { FetchError } from '../../errors/app-error.js';

function assertContentLengthWithinLimit(
  response: Response,
  url: string,
  maxBytes: number
): void {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) return;
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (Number.isNaN(contentLength) || contentLength <= maxBytes) {
    return;
  }

  cancelResponseBody(response);

  throw new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

interface StreamReadState {
  decoder: TextDecoder;
  parts: string[];
  total: number;
}

function createReadState(): StreamReadState {
  return {
    decoder: new TextDecoder(),
    parts: [],
    total: 0,
  };
}

function appendChunk(
  state: StreamReadState,
  chunk: Uint8Array,
  maxBytes: number,
  url: string
): void {
  state.total += chunk.byteLength;

  if (state.total > maxBytes) {
    throw new FetchError(
      `Response exceeds maximum size of ${maxBytes} bytes`,
      url
    );
  }

  const decoded = state.decoder.decode(chunk, { stream: true });
  if (decoded) state.parts.push(decoded);
}

function finalizeRead(state: StreamReadState): void {
  const decoded = state.decoder.decode();
  if (decoded) state.parts.push(decoded);
}

function createAbortError(url: string): FetchError {
  return new FetchError('Request was aborted during response read', url, 499, {
    reason: 'aborted',
  });
}

function cancelResponseBody(response: Response): void {
  const cancelPromise = response.body?.cancel();
  if (cancelPromise) {
    cancelPromise.catch(() => {
      // Best-effort cancellation; ignore failures.
    });
  }
}

async function cancelReaderQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancel errors; we're already failing this read.
  }
}

async function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> {
  if (!signal?.aborted) return;
  await cancelReaderQuietly(reader);
  throw createAbortError(url);
}

async function readAllChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StreamReadState,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<void> {
  await throwIfAborted(signal, url, reader);

  let result = await reader.read();
  while (!result.done) {
    appendChunk(state, result.value, maxBytes, url);
    await throwIfAborted(signal, url, reader);
    result = await reader.read();
  }
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  const state = createReadState();
  const reader = stream.getReader();

  try {
    await readAllChunks(reader, state, url, maxBytes, signal);
  } catch (error) {
    if (!signal?.aborted) {
      await cancelReaderQuietly(reader);
    }
    if (signal?.aborted) {
      throw createAbortError(url);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  finalizeRead(state);
  return { text: state.parts.join(''), size: state.total };
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; size: number }> {
  assertContentLengthWithinLimit(response, url, maxBytes);

  if (!response.body) {
    const text = await response.text();
    const size = Buffer.byteLength(text);
    if (size > maxBytes) {
      throw new FetchError(
        `Response exceeds maximum size of ${maxBytes} bytes`,
        url
      );
    }
    return { text, size };
  }

  return readStreamWithLimit(response.body, url, maxBytes, signal);
}
