import {
  type Progress,
  type ProgressNotification,
  type ProgressNotificationParams,
  type ProgressToken,
  ProtocolError,
  type ServerContext,
} from '@modelcontextprotocol/server';

import type { ServerResponse } from 'node:http';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { z } from 'zod';

import { Loggers, logWarn } from './core.js';
import { getErrorMessage } from './error/index.js';
import { formatZodError } from './utils.js';

export function createProtocolError(
  code: number,
  message: string,
  data?: unknown
): ProtocolError {
  return ProtocolError.fromError(code, message, data);
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export function buildJsonRpcErrorBody(
  code: number,
  message: string,
  id: JsonRpcId = null,
  data?: unknown
): {
  jsonrpc: '2.0';
  error: JsonRpcErrorPayload;
  id: JsonRpcId;
} {
  return {
    jsonrpc: '2.0',
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id,
  };
}

export function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: JsonRpcId = null,
  data?: unknown
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(buildJsonRpcErrorBody(code, message, id, data)));
}

/* =================================================================================================
 * JSON-RPC / Media type parsing
 * ================================================================================================= */

export type JsonRpcId = string | number | null;
const paramsSchema = z.looseObject({
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const jsonRpcRequestIdSchema = z.union([z.string(), z.number()]);
const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: jsonRpcRequestIdSchema.optional(),
  params: paramsSchema.optional(),
});
const jsonRpcResultResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema,
  result: z.record(z.string(), z.unknown()),
});
const jsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema.or(z.null()).optional(),
  error: z.strictObject({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});
const jsonRpcResponseSchema = z.union([
  jsonRpcResultResponseSchema,
  jsonRpcErrorResponseSchema,
]);
const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
]);
type McpRequestBody = z.infer<typeof jsonRpcRequestSchema>;
type JsonRpcResponseBody = z.infer<typeof jsonRpcResponseSchema>;
type JsonRpcMessageBody = z.infer<typeof jsonRpcMessageSchema>;
export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}
export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return jsonRpcRequestSchema.safeParse(body).success;
}
export function isJsonRpcResponseBody(
  body: unknown
): body is JsonRpcResponseBody {
  return jsonRpcResponseSchema.safeParse(body).success;
}
export function isMcpMessageBody(body: unknown): body is JsonRpcMessageBody {
  return jsonRpcMessageSchema.safeParse(body).success;
}
function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((v) => v.split(';', 1)[0]?.trim().toLowerCase() ?? '')
    .filter((v) => v.length > 0);
}
export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}
export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = mediaTypes.some(
    (m) => m === '*/*' || m === 'application/json' || m === 'application/*'
  );
  if (!acceptsJson) return false;

  return mediaTypes.some(
    (m) => m === '*/*' || m === 'text/event-stream' || m === 'text/*'
  );
}

/* =================================================================================================
 * Progress reporting
 * ================================================================================================= */

export { type ProgressNotification, type ProgressNotificationParams };

export interface ProgressReporter {
  report: (progress: Progress) => void;
}

const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;
const PROGRESS_NOTIFICATION_MIN_INTERVAL_MS = 100;

class ToolProgressReporter implements ProgressReporter {
  private lastProgress = -1;
  private lastTotal: number | undefined;
  private pendingNotification: ProgressNotification | undefined;
  private isDispatching = false;
  private lastDispatchedAt = 0;

  private constructor(
    private readonly token: ProgressToken,
    private readonly send: (notification: ProgressNotification) => Promise<void>
  ) {}

  static create(ctx?: ServerContext): ProgressReporter {
    if (!ctx) {
      return { report: () => {} };
    }

    const meta = ctx.mcpReq._meta;
    const token = meta?.progressToken ?? null;

    if (token === null) {
      return { report: () => {} };
    }

    const send = (notification: ProgressNotification): Promise<void> =>
      ctx.mcpReq.notify({
        method: notification.method,
        params: { ...notification.params },
      });

    return new ToolProgressReporter(token, send);
  }

  /**
   * Report progress toward completion. Steps are monotonic (never decrease)
   * and may be skipped under normal conditions (e.g., fast responses skip
   * intermediate steps). Clients should treat progress as "at least this far"
   * rather than expecting every step to fire sequentially.
   */
  report(input: Progress): void {
    const { progress, message, total } = input;
    const effectiveProgress = Math.max(progress, this.lastProgress);
    const effectiveTotal =
      total === undefined ? this.lastTotal : Math.max(total, effectiveProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;

    this.lastProgress = effectiveProgress;
    this.lastTotal = effectiveTotal;

    if (!isIncreasing) return;

    this.pendingNotification = this.createProgressNotification({
      token: this.token,
      progress: effectiveProgress,
      ...(message !== undefined ? { message } : {}),
      ...(effectiveTotal !== undefined ? { total: effectiveTotal } : {}),
    });
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.isDispatching) return;
    this.isDispatching = true;

    void (async (): Promise<void> => {
      try {
        while (this.pendingNotification) {
          const remainingDelay =
            this.lastDispatchedAt +
            PROGRESS_NOTIFICATION_MIN_INTERVAL_MS -
            Date.now();
          if (remainingDelay > 0) {
            await setTimeoutPromise(remainingDelay, undefined, { ref: false });
          }

          const notification = this.pendingNotification;
          this.pendingNotification = undefined;
          await this.sendWithTimeout(notification);
          this.lastDispatchedAt = Date.now();
        }
      } finally {
        this.isDispatching = false;
      }
    })();
  }

  private async sendWithTimeout(
    notification: ProgressNotification
  ): Promise<void> {
    const ac = new AbortController();
    const timeoutPromise = setTimeoutPromise(
      PROGRESS_NOTIFICATION_TIMEOUT_MS,
      { timeout: true as const },
      { signal: ac.signal, ref: false }
    ).catch((err: unknown) => {
      if ((err as Error).name === 'AbortError') return { ok: true as const };
      throw err;
    });

    try {
      const outcome = await Promise.race([
        this.send(notification).then(() => {
          ac.abort();
          return { ok: true as const };
        }),
        timeoutPromise,
      ]);

      if ('timeout' in outcome) {
        logWarn(
          'Progress notification timed out',
          {
            progress: notification.params.progress,
            message: notification.params.message,
          },
          Loggers.LOG_MCP
        );
      }
    } catch (error: unknown) {
      logWarn(
        'Failed to send progress notification',
        {
          error: getErrorMessage(error),
          progress: notification.params.progress,
          message: notification.params.message,
        },
        Loggers.LOG_MCP
      );
    }
  }

  private createProgressNotification(params: {
    token: ProgressToken;
    progress: number;
    message?: string;
    total?: number;
  }): ProgressNotification {
    return {
      method: 'notifications/progress',
      params: {
        progressToken: params.token,
        progress: params.progress,
        ...(params.total !== undefined ? { total: params.total } : {}),
        ...(params.message !== undefined ? { message: params.message } : {}),
      },
    };
  }
}

export const createProgressReporter = (ctx?: ServerContext): ProgressReporter =>
  ToolProgressReporter.create(ctx);

export function validateOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  errorCode: number,
  msg: string,
  logger: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = formatZodError(result.error);
    logWarn(`Zod validation failed: ${msg}`, { issues }, logger);
    throw createProtocolError(errorCode, msg, { issues });
  }
  return result.data;
}
