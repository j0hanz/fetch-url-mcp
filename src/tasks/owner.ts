import { createHash } from 'node:crypto';

import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import type { ProgressNotification } from '../lib/mcp-tools.js';
import { isObject } from '../lib/utils.js';

/* -------------------------------------------------------------------------------------------------
 * Handler extra parsing & owner-key resolution
 * ------------------------------------------------------------------------------------------------- */

interface HandlerExtra {
  sessionId?: string;
  authInfo?: { clientId?: string; token?: string };
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

export interface ToolCallContext {
  ownerKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

/** Strip keys whose value is `undefined`, returning an object with only the
 * present keys. Return type correctly omits the `undefined` union so the result
 * is compatible with `exactOptionalPropertyTypes`. */
type Compacted<T extends object> = {
  [K in keyof T as Exclude<T[K], undefined> extends never
    ? never
    : K]?: Exclude<T[K], undefined>;
};

export function compact<T extends object>(obj: T): Compacted<T> {
  const result: Compacted<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      (result as Record<string, unknown>)[key as string] = obj[key];
    }
  }
  return result;
}

function normalizeSendNotification(
  sendNotification: unknown
): ((notification: ProgressNotification) => Promise<void>) | undefined {
  if (typeof sendNotification !== 'function') return undefined;
  const notify = sendNotification as (
    notification: ProgressNotification
  ) => Promise<void> | void;
  return async (notification: ProgressNotification): Promise<void> => {
    await Promise.resolve(notify(notification));
  };
}

function normalizeAuthInfo(
  authInfo: unknown
): NonNullable<HandlerExtra['authInfo']> | undefined {
  if (!isObject(authInfo)) return undefined;

  const { clientId, token } = authInfo;
  const normalized: NonNullable<HandlerExtra['authInfo']> = {};
  if (typeof clientId === 'string') normalized.clientId = clientId;
  if (typeof token === 'string') normalized.token = token;

  return normalized.clientId || normalized.token ? normalized : undefined;
}

export function parseHandlerExtra(extra: unknown): HandlerExtra | undefined {
  if (!isObject(extra)) return undefined;

  const parsed: HandlerExtra = {};
  const { sessionId, authInfo, signal, requestId, sendNotification } = extra;
  if (typeof sessionId === 'string') parsed.sessionId = sessionId;

  const normalizedAuthInfo = normalizeAuthInfo(authInfo);
  if (normalizedAuthInfo) {
    parsed.authInfo = normalizedAuthInfo;
  }

  if (signal instanceof AbortSignal) parsed.signal = signal;

  if (typeof requestId === 'string' || typeof requestId === 'number') {
    parsed.requestId = requestId;
  }

  const normalizedSendNotification =
    normalizeSendNotification(sendNotification);
  if (normalizedSendNotification) {
    parsed.sendNotification = normalizedSendNotification;
  }

  return parsed;
}

export function resolveTaskOwnerKey(extra?: HandlerExtra): string {
  if (extra?.sessionId) return `session:${extra.sessionId}`;
  if (extra?.authInfo?.clientId) return `client:${extra.authInfo.clientId}`;
  if (extra?.authInfo?.token)
    return `token:${createHash('sha256').update(extra.authInfo.token).digest('hex')}`;
  return 'default';
}

export function resolveToolCallContext(extra?: HandlerExtra): ToolCallContext {
  return compact({
    ownerKey: resolveTaskOwnerKey(extra),
    sessionId: extra?.sessionId,
    signal: extra?.signal,
    requestId: extra?.requestId,
    sendNotification: extra?.sendNotification,
  }) as ToolCallContext;
}

export function isServerResult(value: unknown): value is ServerResult {
  return (
    isObject(value) && Array.isArray((value as { content?: unknown }).content)
  );
}

export function tryReadToolStructuredError(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const record = value as { content?: unknown[] };
  if (!Array.isArray(record.content) || record.content.length === 0)
    return undefined;
  const firstBlock = record.content[0];
  if (
    !isObject(firstBlock) ||
    firstBlock['type'] !== 'text' ||
    typeof firstBlock['text'] !== 'string'
  )
    return undefined;
  try {
    const parsed = JSON.parse(firstBlock['text']) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
