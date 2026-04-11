import {
  type McpServer,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  type ServerContext,
  type ServerResult,
} from '@modelcontextprotocol/server';

import { hash } from 'node:crypto';

import { z } from 'zod';

import { config } from '../lib/config.js';
import {
  logDebug,
  logError,
  Loggers,
  logWarn,
  resolveMcpSessionOwnerKey,
} from '../lib/core.js';
import { getErrorMessage } from '../lib/error/index.js';
import { createProtocolError } from '../lib/mcp-interop.js';
import { isObject } from '../lib/utils.js';

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
 * - Abort-controller management for in-flight task executions
 * - Task notification and validation helpers
 * - Task handler schemas and registration
 * - Owner-key resolution
 * Own task lifecycle and MCP task wiring here. Keep tool business logic and HTTP transport details elsewhere.
 */

interface RelatedTaskMeta {
  taskId: string;
}

export interface ToolCallRequestMeta extends Record<string, unknown> {
  progressToken?: string | number;
  [RELATED_TASK_META_KEY]?: RelatedTaskMeta;
}

export {
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
  TaskWaiterRegistry,
  waitForTerminalTask,
};
export type { CreateTaskResult, TaskState, TaskStatus };

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
  | 'ttl'
  | 'pollInterval'
>;

export function toTaskSummary(task: TaskLifecycleProjection): TaskSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    pollInterval: task.pollInterval,
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
interface TaskHandlerRegistrationResult {
  taskCapableToolsRegistered: boolean;
}

export function registerTaskHandlers(
  server: McpServer
): TaskHandlerRegistrationResult {
  const taskCapableToolsRegistered = config.tools.enabled.includes('fetch-url');

  server.server.fallbackRequestHandler = (request, ctx) => {
    if (request.method !== 'tasks/delete') {
      throw createProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Method not found: ${request.method}`
      );
    }

    const parsedRequest = TaskDeleteSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const ownerKey = resolveOwnerKeyFromContext(ctx);
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
 * Owner-key resolution
 * ------------------------------------------------------------------------------------------------- */

interface AuthIdentity {
  clientId?: string;
  token?: string;
  extra?: Record<string, unknown>;
}

function resolveAuthenticatedSubject(
  authInfo?: AuthIdentity
): string | undefined {
  const extra = isObject(authInfo?.extra) ? authInfo.extra : undefined;
  if (!extra) return undefined;

  const { subject, sub } = extra;
  if (typeof subject === 'string' && subject.length > 0) {
    return subject;
  }

  return typeof sub === 'string' && sub.length > 0 ? sub : undefined;
}

export function buildAuthenticatedOwnerKey(
  authInfo?: AuthIdentity
): string | undefined {
  const authSubject = resolveAuthenticatedSubject(authInfo);
  if (authSubject) {
    const hashInput = `subject:${authSubject}`;
    return `auth:${hash('sha256', hashInput, 'hex')}`;
  }

  const authClientId =
    typeof authInfo?.clientId === 'string' ? authInfo.clientId : '';
  const authToken = typeof authInfo?.token === 'string' ? authInfo.token : '';

  if (authClientId || authToken) {
    const hashInput = `${authClientId}:${authToken}`;
    return `auth:${hash('sha256', hashInput, 'hex')}`;
  }

  return undefined;
}

export function resolveOwnerKeyFromContext(ctx: ServerContext): string {
  const authInfo = ctx.http?.authInfo;
  if (authInfo) {
    const identity: AuthIdentity = {
      clientId: authInfo.clientId,
      token: authInfo.token,
      ...(authInfo.extra ? { extra: authInfo.extra } : {}),
    };
    const authenticatedOwnerKey = buildAuthenticatedOwnerKey(identity);
    if (authenticatedOwnerKey) return authenticatedOwnerKey;
  }

  const { sessionId } = ctx;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return resolveMcpSessionOwnerKey(sessionId) ?? `session:${sessionId}`;
  }

  return 'default';
}

export function isServerResult(value: unknown): value is ServerResult {
  return isObject(value) && Array.isArray(value['content']);
}
