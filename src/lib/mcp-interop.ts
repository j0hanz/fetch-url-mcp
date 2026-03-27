import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logError, logWarn } from './core.js';
import {
  FetchError,
  getErrorMessage,
  isAbortError,
  isObject,
  isSystemError,
} from './utils.js';

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
 * Tool error handling
 * ================================================================================================= */

type ToolErrorResponse = CallToolResult & {
  isError: true;
};

const PUBLIC_ERROR_REASONS = new Set(['aborted', 'queue_full', 'timeout']);

function sanitizeToolErrorDetails(
  details: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};

  const { retryAfter, timeout, reason } = details;
  if (
    typeof retryAfter === 'number' ||
    typeof retryAfter === 'string' ||
    retryAfter === null
  ) {
    sanitized['retryAfter'] = retryAfter;
  }

  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) {
    sanitized['timeout'] = timeout;
  }

  if (typeof reason === 'string' && PUBLIC_ERROR_REASONS.has(reason)) {
    sanitized['reason'] = reason;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function createToolErrorResponse(
  message: string,
  url: string,
  extra?: {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  }
): ToolErrorResponse {
  const errorContent: Record<string, unknown> = {
    error: message,
    ...(extra?.code ? { code: extra.code } : {}),
    url,
    ...(extra?.statusCode !== undefined
      ? { statusCode: extra.statusCode }
      : {}),
    ...(extra?.details ? { details: extra.details } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(errorContent) }],
    isError: true,
  };
}
function isValidationError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    isSystemError(error) &&
    error.code === 'VALIDATION_ERROR'
  );
}
export function handleToolError(
  error: unknown,
  url: string,
  fallbackMessage = 'Operation failed'
): ToolErrorResponse {
  if (error instanceof FetchError) {
    const { code: detailsCode, reason } = error.details;
    let { code } = error;
    if (typeof detailsCode === 'string') {
      code = detailsCode;
    } else if (reason === 'queue_full') {
      code = 'queue_full';
    }
    const details = sanitizeToolErrorDetails(error.details);
    return createToolErrorResponse(error.message, url, {
      code,
      statusCode: error.statusCode,
      ...(details ? { details } : {}),
    });
  }
  if (isValidationError(error)) {
    return createToolErrorResponse(error.message, url, {
      code: 'VALIDATION_ERROR',
    });
  }
  const code = isAbortError(error) ? 'ABORTED' : 'FETCH_ERROR';
  const message =
    error instanceof Error
      ? `${fallbackMessage}: ${error.message}`
      : `${fallbackMessage}: Unknown error`;
  return createToolErrorResponse(message, url, { code });
}

/* =================================================================================================
 * SDK interop — server lifecycle & capability patching
 * ================================================================================================= */

type CleanupCallback = () => void;
type RequestHandlerFn = (request: unknown, extra?: unknown) => Promise<unknown>;

function getNestedRecord(
  value: Record<PropertyKey, unknown>,
  key: string
): Record<PropertyKey, unknown> | undefined {
  const nested = value[key];
  return isObject(nested) ? nested : undefined;
}

const patchedCleanupServers = new WeakSet<McpServer>();
const serverCleanupCallbacks = new WeakMap<McpServer, Set<CleanupCallback>>();

function getServerCleanupCallbackSet(server: McpServer): Set<CleanupCallback> {
  let callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks) {
    callbacks = new Set<CleanupCallback>();
    serverCleanupCallbacks.set(server, callbacks);
  }
  return callbacks;
}

function drainServerCleanupCallbacks(server: McpServer): void {
  const callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks || callbacks.size === 0) return;

  const pending = [...callbacks];
  callbacks.clear();
  for (const callback of pending) {
    try {
      callback();
    } catch (error: unknown) {
      logWarn('Server cleanup callback failed', { error });
    }
  }
}

function ensureServerCleanupHooks(server: McpServer): void {
  if (patchedCleanupServers.has(server)) return;
  patchedCleanupServers.add(server);

  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    drainServerCleanupCallbacks(server);
    originalOnClose?.();
  };

  const originalClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    drainServerCleanupCallbacks(server);
    await originalClose();
  };
}

export function registerServerLifecycleCleanup(
  server: McpServer,
  callback: CleanupCallback
): void {
  ensureServerCleanupHooks(server);
  getServerCleanupCallbackSet(server).add(callback);
}

/**
 * Retrieves the SDK's internal request-handler map.
 *
 * Depends on SDK private API `_requestHandlers` (verified against ^1.28).
 * If the SDK changes this internal, the sdk-compat-guard.test.ts tests will fail.
 */
export function getSdkCallToolHandler(
  server: McpServer
): RequestHandlerFn | null {
  const maybeHandlers: unknown = Reflect.get(server.server, '_requestHandlers');
  if (!(maybeHandlers instanceof Map)) return null;

  const handler: unknown = maybeHandlers.get('tools/call');
  return typeof handler === 'function' ? (handler as RequestHandlerFn) : null;
}

/**
 * Patches the SDK's internal capabilities to enable/disable task-mode tool calls.
 *
 * Depends on SDK private API `_capabilities.tasks.requests` (verified against ^1.28).
 * If the SDK changes this internal, the sdk-compat-guard.test.ts tests will fail.
 */
export function setTaskToolCallCapability(
  server: McpServer,
  enabled: boolean
): void {
  const capabilities: unknown = Reflect.get(server.server, '_capabilities');
  if (!isObject(capabilities)) return;

  const tasks = getNestedRecord(capabilities, 'tasks');
  if (!tasks) return;

  const requests = getNestedRecord(tasks, 'requests');
  if (!requests) return;

  if (enabled) {
    requests.tools = { call: {} };
    return;
  }

  delete requests.tools;
}

/* =================================================================================================
 * Progress reporting
 * ================================================================================================= */

type ProgressToken = string | number;

interface RequestMeta {
  progressToken?: ProgressToken | undefined;
  [key: string]: unknown;
}

export interface ProgressNotificationParams {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
  _meta?: Record<string, unknown>;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: ProgressNotificationParams;
}

export interface ToolHandlerExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  sessionId?: unknown;
  requestInfo?: unknown;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  onProgress?: (progress: number, message: string) => void;
  canReportProgress?: () => boolean;
}

export interface ProgressReporter {
  report: (progress: number, message: string) => void;
}

const DEFAULT_PROGRESS_TOTAL = 8;
const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;

function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  const related = meta?.['io.modelcontextprotocol/related-task'];
  if (!isObject(related)) return undefined;
  const { taskId } = related;
  return typeof taskId === 'string' ? { taskId } : undefined;
}

class ToolProgressReporter implements ProgressReporter {
  private isTerminal = false;
  private lastProgress = -1;
  private lastMessage?: string;
  private pendingNotification: ProgressNotification | undefined;
  private isDispatching = false;

  private constructor(
    private readonly token: ProgressToken | null,
    private readonly handlers: {
      send: ((notification: ProgressNotification) => Promise<void>) | undefined;
      onProgress: ((progress: number, message: string) => void) | undefined;
      canReport: (() => boolean) | undefined;
    },
    private readonly taskMeta?: { taskId: string }
  ) {}

  static create(extra: ToolHandlerExtra = {}): ProgressReporter {
    const token = extra._meta?.progressToken ?? null;
    const { onProgress } = extra;

    if (token === null && !onProgress) {
      return { report: () => {} };
    }

    return new ToolProgressReporter(
      token,
      {
        send: extra.sendNotification,
        onProgress,
        canReport: extra.canReportProgress,
      },
      resolveRelatedTaskMeta(extra._meta)
    );
  }

  /**
   * Report progress toward completion. Steps are monotonic (never decrease)
   * and may be skipped under normal conditions (e.g., fast responses skip
   * intermediate steps). Clients should treat progress as "at least this far"
   * rather than expecting every step to fire sequentially.
   */
  report(progress: number, message: string): void {
    if (this.isTerminal || this.handlers.canReport?.() === false) return;

    const effectiveProgress = Math.max(progress, this.lastProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;
    const isMessageChanged = message !== this.lastMessage;

    this.lastProgress = effectiveProgress;
    this.lastMessage = message;

    if (effectiveProgress >= DEFAULT_PROGRESS_TOTAL) {
      this.isTerminal = true;
    }

    if (isIncreasing || isMessageChanged) {
      try {
        this.handlers.onProgress?.(effectiveProgress, message);
      } catch (error: unknown) {
        logError('Progress callback failed', {
          error: getErrorMessage(error),
          progress: effectiveProgress,
          message,
        });
      }
    }

    if (!isIncreasing || this.token === null || !this.handlers.send) return;

    this.pendingNotification = this.createProgressNotification(
      this.token,
      effectiveProgress,
      message
    );
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.isDispatching || !this.handlers.send) return;
    this.isDispatching = true;

    void (async (): Promise<void> => {
      try {
        while (this.pendingNotification) {
          if (this.handlers.canReport?.() === false) {
            this.pendingNotification = undefined;
            return;
          }

          const notification = this.pendingNotification;
          this.pendingNotification = undefined;
          await this.sendWithTimeout(notification);
        }
      } finally {
        this.isDispatching = false;
      }
    })();
  }

  private async sendWithTimeout(
    notification: ProgressNotification
  ): Promise<void> {
    if (!this.handlers.send) return;

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
        this.handlers.send(notification).then(() => {
          ac.abort();
          return { ok: true as const };
        }),
        timeoutPromise,
      ]);

      if ('timeout' in outcome) {
        logWarn('Progress notification timed out', {
          progress: notification.params.progress,
          message: notification.params.message,
        });
      }
    } catch (error: unknown) {
      logWarn('Failed to send progress notification', {
        error: getErrorMessage(error),
        progress: notification.params.progress,
        message: notification.params.message,
      });
    }
  }

  private createProgressNotification(
    token: ProgressToken,
    progress: number,
    message: string
  ): ProgressNotification {
    return {
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        total: DEFAULT_PROGRESS_TOTAL,
        message,
        ...(this.taskMeta && {
          _meta: {
            'io.modelcontextprotocol/related-task': this.taskMeta,
          },
        }),
      },
    };
  }
}

export const createProgressReporter = (
  extra?: ToolHandlerExtra
): ProgressReporter => ToolProgressReporter.create(extra);
