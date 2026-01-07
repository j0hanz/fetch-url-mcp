import { isRecord } from './guards.js';

export interface CachedPayload {
  content?: string;
  markdown?: string;
  title?: string;
}

export function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveCachedPayloadContent(
  payload: CachedPayload
): string | null {
  if (typeof payload.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return null;
}

function isCachedPayload(value: unknown): value is CachedPayload {
  if (!isRecord(value)) return false;
  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.markdown === undefined || typeof value.markdown === 'string') &&
    (value.title === undefined || typeof value.title === 'string')
  );
}
