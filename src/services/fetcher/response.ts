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

  throw new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number
): Promise<{ text: string; size: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  const chunks: string[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError(
        `Response exceeds maximum size of ${maxBytes} bytes`,
        url
      );
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return { text: chunks.join(''), size: total };
}

export async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number
): Promise<{ text: string; size: number }> {
  assertContentLengthWithinLimit(response, url, maxBytes);

  if (!response.body) {
    const text = await response.text();
    return { text, size: Buffer.byteLength(text) };
  }

  return readStreamWithLimit(response.body, url, maxBytes);
}
