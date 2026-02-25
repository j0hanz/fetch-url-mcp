import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  hash as oneShotHash,
  timingSafeEqual,
} from 'node:crypto';

const MAX_HASH_INPUT_BYTES = 5 * 1024 * 1024;

type AllowedHashAlgorithm = 'sha256' | 'sha512';

const ALLOWED_HASH_ALGORITHMS: ReadonlySet<AllowedHashAlgorithm> = new Set([
  'sha256',
  'sha512',
]);

function byteLengthUtf8(input: string): number {
  // Avoid allocating (unlike TextEncoder().encode()).
  return Buffer.byteLength(input, 'utf8');
}

function byteLength(input: string | Uint8Array): number {
  return typeof input === 'string' ? byteLengthUtf8(input) : input.byteLength;
}

function assertAllowedAlgorithm(
  algorithm: AllowedHashAlgorithm
): asserts algorithm is AllowedHashAlgorithm {
  // Defensive: protects against `any` / unchecked external inputs.
  if (!ALLOWED_HASH_ALGORITHMS.has(algorithm)) {
    throw new Error(`Hash algorithm not allowed: ${algorithm}`);
  }
}

function padBuffer(buffer: Buffer, length: number): Buffer {
  const padded = Buffer.alloc(length);
  buffer.copy(padded);
  return padded;
}

function equalWithPadding(
  aBuffer: Buffer,
  bBuffer: Buffer,
  paddedLength: number
): boolean {
  const paddedA = padBuffer(aBuffer, paddedLength);
  const paddedB = padBuffer(bBuffer, paddedLength);
  return timingSafeEqual(paddedA, paddedB) && aBuffer.length === bBuffer.length;
}

export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length === bBuffer.length) {
    return timingSafeEqual(aBuffer, bBuffer);
  }

  // Avoid early return timing differences on length mismatch.
  const maxLength = Math.max(aBuffer.length, bBuffer.length);
  return equalWithPadding(aBuffer, bBuffer, maxLength);
}

function hashHex(
  algorithm: AllowedHashAlgorithm,
  input: string | Uint8Array
): string {
  assertAllowedAlgorithm(algorithm);

  if (byteLength(input) <= MAX_HASH_INPUT_BYTES) {
    return oneShotHash(algorithm, input, 'hex');
  }

  const hasher = createHash(algorithm);
  hasher.update(input);
  return hasher.digest('hex');
}

export function sha256Hex(input: string | Uint8Array): string {
  return hashHex('sha256', input);
}

export function hmacSha256Hex(
  key: string | Uint8Array,
  input: string | Uint8Array
): string {
  return createHmac('sha256', key).update(input).digest('hex');
}
