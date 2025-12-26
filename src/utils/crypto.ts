import { createHash, hash as oneShotHash, timingSafeEqual } from 'node:crypto';

const MAX_HASH_INPUT_BYTES = 5 * 1024 * 1024;

type AllowedHashAlgorithm = 'sha256' | 'sha512';

const ALLOWED_HASH_ALGORITHMS: ReadonlySet<AllowedHashAlgorithm> = new Set([
  'sha256',
  'sha512',
]);

function byteLength(input: string | Uint8Array): number {
  return typeof input === 'string'
    ? Buffer.byteLength(input, 'utf8')
    : input.byteLength;
}

export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export function hashHex(
  algorithm: AllowedHashAlgorithm,
  input: string | Uint8Array
): string {
  if (!ALLOWED_HASH_ALGORITHMS.has(algorithm)) {
    throw new Error(`Hash algorithm not allowed: ${algorithm}`);
  }

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
