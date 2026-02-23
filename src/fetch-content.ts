import { Buffer } from 'node:buffer';

const UTF8_ENCODING = 'utf-8';

export function getCharsetFromContentType(
  contentType: string | null
): string | undefined {
  if (!contentType) return undefined;
  const match = /charset=([^;]+)/i.exec(contentType);
  const charsetGroup = match?.[1];

  if (!charsetGroup) return undefined;
  let charset = charsetGroup.trim();
  if (charset.startsWith('"') && charset.endsWith('"')) {
    charset = charset.slice(1, -1);
  }
  return charset.trim();
}

function createDecoder(encoding: string | undefined): TextDecoder {
  if (!encoding) return new TextDecoder(UTF8_ENCODING);

  try {
    return new TextDecoder(encoding);
  } catch {
    return new TextDecoder(UTF8_ENCODING);
  }
}

export function decodeBuffer(buffer: Uint8Array, encoding: string): string {
  return createDecoder(encoding).decode(buffer);
}

function normalizeEncodingLabel(encoding: string | undefined): string {
  return encoding?.trim().toLowerCase() ?? '';
}

function isUnicodeWideEncoding(encoding: string | undefined): boolean {
  const normalized = normalizeEncodingLabel(encoding);
  return (
    normalized.startsWith('utf-16') ||
    normalized.startsWith('utf-32') ||
    normalized === 'ucs-2' ||
    normalized === 'unicodefffe' ||
    normalized === 'unicodefeff'
  );
}

const BOM_SIGNATURES: readonly {
  bytes: readonly number[];
  encoding: string;
}[] = [
  // 4-byte BOMs must come first to avoid false matches with 2-byte prefixes
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be' },
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

function startsWithBytes(
  buffer: Uint8Array,
  signature: readonly number[]
): boolean {
  const sigLen = signature.length;
  if (buffer.length < sigLen) return false;

  for (let i = 0; i < sigLen; i += 1) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

function detectBomEncoding(buffer: Uint8Array): string | undefined {
  for (const { bytes, encoding } of BOM_SIGNATURES) {
    if (startsWithBytes(buffer, bytes)) return encoding;
  }
  return undefined;
}

function readQuotedValue(input: string, startIndex: number): string {
  const first = input[startIndex];
  if (!first) return '';

  const quoted = first === '"' || first === "'";
  if (quoted) {
    const end = input.indexOf(first, startIndex + 1);
    return end === -1 ? '' : input.slice(startIndex + 1, end).trim();
  }

  const tail = input.slice(startIndex);
  const stop = tail.search(/[\s/>]/);
  return (stop === -1 ? tail : tail.slice(0, stop)).trim();
}

function findTokenValue(
  original: string,
  lower: string,
  token: string,
  fromIndex = 0
): string | undefined {
  const tokenIndex = lower.indexOf(token, fromIndex);
  if (tokenIndex === -1) return undefined;

  const valueStart = tokenIndex + token.length;
  const value = readQuotedValue(original, valueStart);
  return value || undefined;
}

function extractHtmlCharset(headSnippet: string): string | undefined {
  const lower = headSnippet.toLowerCase();
  const charset = findTokenValue(headSnippet, lower, 'charset=');
  return charset ? charset.toLowerCase() : undefined;
}

function extractXmlEncoding(headSnippet: string): string | undefined {
  const lower = headSnippet.toLowerCase();
  const xmlStart = lower.indexOf('<?xml');
  if (xmlStart === -1) return undefined;

  const xmlEnd = lower.indexOf('?>', xmlStart);
  const declaration =
    xmlEnd === -1
      ? headSnippet.slice(xmlStart)
      : headSnippet.slice(xmlStart, xmlEnd + 2);
  const declarationLower = declaration.toLowerCase();

  const encoding = findTokenValue(declaration, declarationLower, 'encoding=');
  return encoding ? encoding.toLowerCase() : undefined;
}

function detectHtmlDeclaredEncoding(buffer: Uint8Array): string | undefined {
  const scanSize = Math.min(buffer.length, 8_192);
  if (scanSize === 0) return undefined;

  const headSnippet = Buffer.from(
    buffer.buffer,
    buffer.byteOffset,
    scanSize
  ).toString('latin1');

  return extractHtmlCharset(headSnippet) ?? extractXmlEncoding(headSnippet);
}

export function resolveEncoding(
  declaredEncoding: string | undefined,
  sample: Uint8Array
): string | undefined {
  const bomEncoding = detectBomEncoding(sample);
  if (bomEncoding) return bomEncoding;

  if (declaredEncoding) return declaredEncoding;

  return detectHtmlDeclaredEncoding(sample);
}

const BINARY_SIGNATURES = [
  [0x25, 0x50, 0x44, 0x46],
  [0x89, 0x50, 0x4e, 0x47],
  [0x47, 0x49, 0x46, 0x38],
  [0xff, 0xd8, 0xff],
  [0x52, 0x49, 0x46, 0x46],
  [0x42, 0x4d],
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
  [0x00, 0x00, 0x01, 0x00],
  [0x50, 0x4b, 0x03, 0x04],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0x52, 0x61, 0x72, 0x21],
  [0x37, 0x7a, 0xbc, 0xaf],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0x00, 0x61, 0x73, 0x6d],
  [0x1a, 0x45, 0xdf, 0xa3],
  [0x66, 0x74, 0x79, 0x70],
  [0x46, 0x4c, 0x56],
  [0x49, 0x44, 0x33],
  [0xff, 0xfb],
  [0xff, 0xfa],
  [0x4f, 0x67, 0x67, 0x53],
  [0x66, 0x4c, 0x61, 0x43],
  [0x4d, 0x54, 0x68, 0x64],
  [0x77, 0x4f, 0x46, 0x46],
  [0x00, 0x01, 0x00, 0x00],
  [0x4f, 0x54, 0x54, 0x4f],
  [0x53, 0x51, 0x4c, 0x69],
] as const;

function hasNullByte(buffer: Uint8Array, limit: number): boolean {
  const checkLen = Math.min(buffer.length, limit);
  return buffer.subarray(0, checkLen).includes(0x00);
}

export function isBinaryContent(
  buffer: Uint8Array,
  encoding?: string
): boolean {
  for (const signature of BINARY_SIGNATURES) {
    if (startsWithBytes(buffer, signature)) return true;
  }

  return !isUnicodeWideEncoding(encoding) && hasNullByte(buffer, 1000);
}
