import { hash, randomUUID } from 'node:crypto';

import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { getRequestId, runWithRequestContext } from '../lib/core.js';
import type { ProgressNotification } from '../lib/progress.js';
import type { ToolHandlerExtra } from '../lib/progress.js';
import { isObject } from '../lib/utils.js';

import {
  sanitizeToolCallMeta,
  type ToolCallRequestMeta,
} from './call-contract.js';

/* -------------------------------------------------------------------------------------------------
 * Handler extra parsing & owner-key resolution
 * ------------------------------------------------------------------------------------------------- */

interface HandlerExtra {
  sessionId?: string;
  authInfo?: { clientId?: string; token?: string };
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  requestInfo?: unknown;
}

export interface ToolExecutionContext {
  ownerKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  requestMeta?: ToolCallRequestMeta;
}

export type ToolCallContext = ToolExecutionContext;

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
    return `token:${hash('sha256', extra.authInfo.token, 'hex')}`;
  return 'default';
}

function resolveRequestIdFromExtra(extra: unknown): string | undefined {
  if (!isObject(extra)) return undefined;

  const { requestId } = extra as { requestId?: unknown };
  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);

  return undefined;
}

function resolveSessionIdFromExtra(extra: unknown): string | undefined {
  if (!isObject(extra)) return undefined;

  const { sessionId } = extra as { sessionId?: unknown };
  if (typeof sessionId === 'string') return sessionId;

  const { requestInfo } = extra;
  if (!isObject(requestInfo)) return undefined;

  const { headers } = requestInfo;
  if (!isObject(headers)) return undefined;

  const headerValue = headers['mcp-session-id'];
  return typeof headerValue === 'string' ? headerValue : undefined;
}

function resolveToolExecutionContext(
  extra?: HandlerExtra,
  requestMeta?: ToolCallRequestMeta
): ToolExecutionContext {
  return compact({
    ownerKey: resolveTaskOwnerKey(extra),
    sessionId: extra?.sessionId,
    signal: extra?.signal,
    requestId: extra?.requestId,
    sendNotification: extra?.sendNotification,
    requestMeta: sanitizeToolCallMeta(requestMeta),
  }) as ToolExecutionContext;
}

export function resolveToolCallContext(
  extra?: HandlerExtra,
  requestMeta?: ToolCallRequestMeta
): ToolCallContext {
  return resolveToolExecutionContext(extra, requestMeta);
}

export function buildToolHandlerExtra(
  context: ToolExecutionContext,
  requestMeta?: ToolCallRequestMeta
): ToolHandlerExtra {
  return compact({
    signal: context.signal,
    requestId: context.requestId,
    sendNotification: context.sendNotification,
    _meta: sanitizeToolCallMeta(requestMeta ?? context.requestMeta),
  }) as ToolHandlerExtra;
}

export function withRequestContextIfMissing<TParams, TResult, TExtra = unknown>(
  handler: (params: TParams, extra?: TExtra) => Promise<TResult>
): (params: TParams, extra?: TExtra) => Promise<TResult> {
  return async (params, extra) => {
    const existingRequestId = getRequestId();
    if (existingRequestId) {
      return handler(params, extra);
    }

    const derivedRequestId = resolveRequestIdFromExtra(extra) ?? randomUUID();
    const derivedSessionId = resolveSessionIdFromExtra(extra);

    return runWithRequestContext(
      {
        requestId: derivedRequestId,
        operationId: derivedRequestId,
        ...(derivedSessionId ? { sessionId: derivedSessionId } : {}),
      },
      () => handler(params, extra)
    );
  };
}

export function isServerResult(value: unknown): value is ServerResult {
  return (
    isObject(value) && Array.isArray((value as { content?: unknown }).content)
  );
}

const toolErrorContentSchema = z.strictObject({
  error: z.string(),
});

const toolErrorBlockSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});

export function tryReadToolStructuredError(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const record = value as { content?: unknown[] };
  if (!Array.isArray(record.content) || record.content.length === 0)
    return undefined;
  const parsedBlock = toolErrorBlockSchema.safeParse(record.content[0]);
  if (!parsedBlock.success) return undefined;

  try {
    const parsed = toolErrorContentSchema.safeParse(
      JSON.parse(parsedBlock.data.text)
    );
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}
