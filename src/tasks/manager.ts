import {
  type McpServer,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  type ServerContext,
  type ServerResult,
} from '@modelcontextprotocol/server';

import { hash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { config } from '../lib/config.js';
import {
  getRequestId,
  logDebug,
  logError,
  Loggers,
  logWarn,
  resolveMcpSessionOwnerKey,
  runWithRequestContext,
  runWithTraceContext,
} from '../lib/core.js';
import { getErrorMessage } from '../lib/error/index.js';
import {
  createProtocolError,
  type ProgressNotification,
  registerServerLifecycleCleanup,
} from '../lib/mcp-interop.js';
import { formatZodError, isObject } from '../lib/utils.js';

import {
  type CreateTaskResult,
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
  type TaskState,
  type TaskStatus,
  TaskWaiterRegistry,
  waitForTerminalTask,
} from './store.js';

/*
 * Module map:
 * - call-tool request parsing
 * - Abort-controller management for in-flight task executions
 * - Task notification and validation helpers
 * - Execution pipeline
 * - Task handler schemas and registration
 * - Handler extra parsing & owner-key resolution
 * Own task lifecycle and MCP task wiring here. Keep tool business logic and HTTP transport details elsewhere.
 */

const MIN_TASK_KEEP_ALIVE_MS = 1_000;
const MAX_TASK_KEEP_ALIVE_MS = 86_400_000;

const taskMetaSchema = z.strictObject({
  taskId: z.string().min(1, 'Task id required'),
  keepAlive: z
    .number()
    .int()
    .min(MIN_TASK_KEEP_ALIVE_MS, `Minimum ${MIN_TASK_KEEP_ALIVE_MS}ms`)
    .max(MAX_TASK_KEEP_ALIVE_MS, `Maximum ${MAX_TASK_KEEP_ALIVE_MS}ms`)
    .optional(),
});

const relatedTaskMetaSchema = z.strictObject({
  taskId: z.string(),
});

const toolCallMetaSchema = z.looseObject({
  progressToken: z.union([z.string(), z.number()]).optional(),
  'modelcontextprotocol.io/task': taskMetaSchema.optional(),
  [RELATED_TASK_META_KEY]: relatedTaskMetaSchema.optional(),
});

const sdkTaskParamsSchema = z.object({ ttl: z.number().optional() }).optional();

export const extendedCallToolRequestSchema = z.looseObject({
  method: z.literal('tools/call'),
  params: z.strictObject({
    name: z.string().min(1, 'Tool name required'),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: toolCallMetaSchema.optional(),
    task: sdkTaskParamsSchema,
  }),
});

export type ExtendedCallToolRequest = z.infer<
  typeof extendedCallToolRequestSchema
>;
export type ToolCallRequestMeta = ExtendedCallToolRequest['params']['_meta'];

export {
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
  TaskWaiterRegistry,
  waitForTerminalTask,
};
export type { CreateTaskResult, TaskState, TaskStatus };

export function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = extendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;

  throw createProtocolError(
    ProtocolErrorCode.InvalidParams,
    formatZodError(parsed.error)
  );
}

export function sanitizeToolCallMeta(
  meta?: ToolCallRequestMeta
): ToolCallRequestMeta | undefined {
  if (!meta) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(meta).filter(([key]) => key !== RELATED_TASK_META_KEY)
  ) as NonNullable<ToolCallRequestMeta>;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildRelatedTaskMeta(
  taskId: string,
  meta?: ToolCallRequestMeta
): Record<string, unknown> {
  return {
    ...(sanitizeToolCallMeta(meta) ?? {}),
    [RELATED_TASK_META_KEY]: { taskId },
  };
}

export function withRelatedTaskMeta(
  result: ServerResult,
  taskId: string
): ServerResult {
  return {
    ...result,
    _meta: {
      ...result._meta,
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

function withRelatedTaskSummaryMeta<T extends Record<string, unknown>>(
  payload: T,
  taskId: string
): T & { _meta: Record<string, unknown> } {
  return {
    ...payload,
    _meta: {
      ...(isObject(payload['_meta']) ? payload['_meta'] : {}),
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Abort-controller management for in-flight task executions
 * ------------------------------------------------------------------------------------------------- */

// Intentionally process-global (not session-scoped): abortAllTaskExecutions() is called
// during SIGTERM/SIGINT shutdown to cancel every in-flight task across all sessions.
const taskAbortControllers = new Map<string, AbortController>();

export function detachAbortController(
  taskId: string
): AbortController | undefined {
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    taskAbortControllers.delete(taskId);
  }
  return controller;
}

export function attachAbortController(taskId: string): AbortController {
  detachAbortController(taskId)?.abort();

  if (taskAbortControllers.size >= config.tasks.maxTotal) {
    logWarn(
      'Abort controller map reached task capacity — possible leak',
      {
        size: taskAbortControllers.size,
        maxTotal: config.tasks.maxTotal,
      },
      Loggers.LOG_TASKS
    );
  }

  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller;
}

export function abortTaskExecution(taskId: string): void {
  detachAbortController(taskId)?.abort();
}

export function cancelTasksForOwner(
  ownerKey: string,
  statusMessage = 'The task was cancelled because its owner session ended.'
): number {
  if (!ownerKey) return 0;
  const cancelled = taskManager.cancelTasksByOwner(ownerKey, statusMessage);
  for (const task of cancelled) {
    abortTaskExecution(task.taskId);
  }
  return cancelled.length;
}

export function abortAllTaskExecutions(): void {
  for (const taskId of taskAbortControllers.keys()) abortTaskExecution(taskId);
}

/* -------------------------------------------------------------------------------------------------
 * Task notification and validation helpers
 * ------------------------------------------------------------------------------------------------- */

type TaskSummary = CreateTaskResult['task'];
type TaskLifecycleProjection = Pick<
  TaskState,
  | 'taskId'
  | 'status'
  | 'statusMessage'
  | 'createdAt'
  | 'lastUpdatedAt'
  | 'keepAlive'
  | 'pollFrequency'
>;

export function toTaskSummary(task: TaskLifecycleProjection): TaskSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    keepAlive: task.keepAlive,
    pollFrequency: task.pollFrequency,
    ttl: task.keepAlive,
    pollInterval: task.pollFrequency,
  };
}

export function emitTaskStatusNotification(
  server: McpServer,
  task: TaskState
): void {
  if (!config.tasks.emitStatusNotifications || !server.isConnected()) return;

  void server.server
    .notification({
      method: 'notifications/tasks/status',
      params: withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId),
    })
    .catch((error: unknown) => {
      logError(
        'Failed to send task status notification',
        {
          taskId: task.taskId,
          status: task.status,
          error: getErrorMessage(error),
        },
        Loggers.LOG_TASKS
      );
    });
}

export function throwTaskNotFound(): never {
  throw createProtocolError(
    ProtocolErrorCode.ResourceNotFound,
    'Task not found'
  );
}

/* -------------------------------------------------------------------------------------------------
 * Task handler schemas and registration
 * ------------------------------------------------------------------------------------------------- */

const TaskDeleteSchema = z.looseObject(
  {
    method: z.literal('tasks/delete', 'Expected "tasks/delete"'),
    params: z.looseObject(
      { taskId: z.string('Expected string') },
      'Expected object'
    ),
  },
  'Invalid request'
);
function resolveOwnerScopedExtra(extra: unknown): {
  parsedExtra: ReturnType<typeof parseHandlerExtra>;
  ownerKey: string;
} {
  const parsedExtra = parseHandlerExtra(extra);
  return {
    parsedExtra,
    ownerKey: resolveTaskOwnerKey(parsedExtra),
  };
}
interface TaskHandlerRegistrationResult {
  taskCapableToolsRegistered: boolean;
}

export function registerTaskHandlers(
  server: McpServer
): TaskHandlerRegistrationResult {
  const taskCapableToolsRegistered = hasRegisteredTaskCapableTools(server);

  server.server.fallbackRequestHandler = (request, ctx) => {
    if (request.method !== 'tasks/delete') {
      throw createProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Method not found: ${request.method}`
      );
    }

    const parsedRequest = TaskDeleteSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const { ownerKey } = resolveOwnerScopedExtra(ctx);
    logDebug('tasks/delete requested', { taskId }, Loggers.LOG_TASKS);

    const deleted = taskManager.deleteTask(taskId, ownerKey);
    if (!deleted) throwTaskNotFound();

    return Promise.resolve({});
  };

  return {
    taskCapableToolsRegistered,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Handler extra parsing & owner-key resolution
 * ------------------------------------------------------------------------------------------------- */

interface HandlerExtra {
  sessionId?: string;
  authInfo?: { clientId?: string; token?: string };
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  _meta?: ToolCallRequestMeta;
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

interface AuthIdentity {
  clientId?: string;
  token?: string;
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

function isServerContextLike(
  extra: unknown
): extra is Pick<ServerContext, 'mcpReq' | 'http' | 'sessionId'> {
  return isObject(extra) && 'mcpReq' in extra;
}

export function parseHandlerExtra(extra: unknown): HandlerExtra | undefined {
  if (!isServerContextLike(extra) && !isObject(extra)) return undefined;
  const ctx = extra as Partial<ServerContext>;

  const parsed: HandlerExtra = {};
  const authInfo = ctx.http?.authInfo;
  const signal = ctx.mcpReq?.signal;
  const requestId = ctx.mcpReq?.id;
  const sendNotification = ctx.mcpReq?.notify;
  const sessionId = resolveSessionIdFromExtra(ctx);
  if (sessionId) parsed.sessionId = sessionId;

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

  if (isObject(ctx.mcpReq?._meta)) {
    parsed._meta = ctx.mcpReq._meta as ToolCallRequestMeta;
  }

  return parsed;
}

export function buildAuthenticatedOwnerKey(
  authInfo?: AuthIdentity
): string | undefined {
  const authClientId =
    typeof authInfo?.clientId === 'string' ? authInfo.clientId : '';
  const authToken = typeof authInfo?.token === 'string' ? authInfo.token : '';

  if (authClientId || authToken) {
    const hashInput = `${authClientId}:${authToken}`;
    return `auth:${hash('sha256', hashInput, 'hex')}`;
  }

  return undefined;
}

export function resolveTaskOwnerKey(extra?: HandlerExtra): string {
  const authenticatedOwnerKey = buildAuthenticatedOwnerKey(extra?.authInfo);
  if (authenticatedOwnerKey) return authenticatedOwnerKey;

  if (extra?.sessionId) {
    return (
      resolveMcpSessionOwnerKey(extra.sessionId) ?? `session:${extra.sessionId}`
    );
  }

  return 'default';
}

function resolveRequestIdFromExtra(extra: unknown): string | undefined {
  const parsedExtra = parseHandlerExtra(extra);
  if (!parsedExtra) return undefined;

  const { requestId } = parsedExtra;
  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);

  return undefined;
}

function getHeaderString(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value ?? undefined;
}

function resolveSessionIdFromExtra(
  extra: Partial<ServerContext> | undefined
): string | undefined {
  const { sessionId } = extra ?? {};
  if (typeof sessionId === 'string') return sessionId;

  const headers = extra?.http?.req?.headers;
  if (!(headers instanceof Headers)) return undefined;

  return (
    getHeaderString(headers, 'mcp-session-id') ??
    getHeaderString(headers, 'x-mcp-session-id')
  );
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
  extra?: HandlerExtra | ToolCallContext | ServerContext,
  requestMeta?: ToolCallRequestMeta
): ToolCallContext {
  if (isServerContextLike(extra)) {
    return resolveToolExecutionContext(parseHandlerExtra(extra), requestMeta);
  }

  if (extra && 'ownerKey' in extra && typeof extra.ownerKey === 'string') {
    return compact({
      ownerKey: extra.ownerKey,
      sessionId: extra.sessionId,
      signal: extra.signal,
      requestId: extra.requestId,
      sendNotification: extra.sendNotification,
      requestMeta: sanitizeToolCallMeta(requestMeta ?? extra.requestMeta),
    }) as ToolCallContext;
  }

  return resolveToolExecutionContext(extra, requestMeta);
}

export function withRequestContextIfMissing<TParams, TResult, TExtra = unknown>(
  handler: (params: TParams, extra?: TExtra) => Promise<TResult>
): (params: TParams, extra?: TExtra) => Promise<TResult> {
  return async (params, extra) => {
    const existingRequestId = getRequestId();
    if (existingRequestId) {
      const traceMeta = parseHandlerExtra(extra)?._meta;
      return runWithTraceContext(traceMeta, () => handler(params, extra));
    }

    const derivedRequestId = resolveRequestIdFromExtra(extra) ?? randomUUID();
    const derivedSessionId = resolveSessionIdFromExtra(
      extra as Partial<ServerContext> | undefined
    );

    const traceMeta = parseHandlerExtra(extra)?._meta;

    return runWithRequestContext(
      {
        requestId: derivedRequestId,
        operationId: derivedRequestId,
        ...(derivedSessionId ? { sessionId: derivedSessionId } : {}),
      },
      () => runWithTraceContext(traceMeta, () => handler(params, extra))
    );
  };
}

export function isServerResult(value: unknown): value is ServerResult {
  return isObject(value) && Array.isArray(value['content']);
}

export type TaskCapableToolSupport = 'required' | 'optional' | 'forbidden';

const taskSupportByServer = new WeakMap<
  McpServer,
  Map<string, TaskCapableToolSupport>
>();

function getServerTaskSupportMap(
  server: McpServer
): Map<string, TaskCapableToolSupport> {
  let map = taskSupportByServer.get(server);
  if (map) return map;

  map = new Map<string, TaskCapableToolSupport>();
  taskSupportByServer.set(server, map);
  registerServerLifecycleCleanup(server, () => {
    taskSupportByServer.delete(server);
  });
  return map;
}

export function registerToolTaskSupport(
  server: McpServer,
  name: string,
  support: TaskCapableToolSupport = 'optional'
): void {
  getServerTaskSupportMap(server).set(name, support);
}

export function unregisterToolTaskSupport(
  server: McpServer,
  name: string
): void {
  getServerTaskSupportMap(server).delete(name);
}

export function getTaskCapableToolSupport(
  server: McpServer,
  name: string
): TaskCapableToolSupport | undefined {
  return getServerTaskSupportMap(server).get(name);
}

export function hasRegisteredTaskCapableTools(server: McpServer): boolean {
  return getServerTaskSupportMap(server).size > 0;
}

export function setTaskCapableToolSupport(
  server: McpServer,
  name: string,
  support: TaskCapableToolSupport
): void {
  const map = getServerTaskSupportMap(server);
  if (map.has(name)) {
    map.set(name, support);
  }
}
