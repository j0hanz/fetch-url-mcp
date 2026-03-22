import { createHmac, randomBytes } from 'node:crypto';

import { timingSafeEqualUtf8 } from '../lib/utils.js';

const MAX_CURSOR_LENGTH = 256;
const CURSOR_SECRET = randomBytes(32);

function signPayload(payload: string): string {
  return createHmac('sha256', CURSOR_SECRET)
    .update(payload)
    .digest('base64url');
}

export function encodeTaskCursor(anchorTaskId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ anchorTaskId }),
    'utf8'
  ).toString('base64url');
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

export function decodeTaskCursor(
  cursor: string
): { anchorTaskId: string } | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) return null;

  const [payload, signature, ...rest] = cursor.split('.');
  if (!payload || !signature || rest.length > 0) return null;
  if (!timingSafeEqualUtf8(signPayload(payload), signature)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { anchorTaskId?: unknown };
    if (
      typeof decoded.anchorTaskId !== 'string' ||
      decoded.anchorTaskId.length === 0 ||
      decoded.anchorTaskId.length > 128
    ) {
      return null;
    }

    return { anchorTaskId: decoded.anchorTaskId };
  } catch {
    return null;
  }
}
