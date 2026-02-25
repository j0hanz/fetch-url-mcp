import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { logWarn, runWithRequestContext } from '../observability.js';
import {
  FETCH_URL_TOOL_NAME,
  type FetchUrlInput,
  fetchUrlInputSchema,
  fetchUrlToolHandler,
  type ProgressNotification,
} from '../tools.js';
import { isObject } from '../type-guards.js';
import {
  type CreateTaskResult,
  taskManager,
  type TaskState,
} from './manager.js';
import {
  compact,
  type ToolCallContext,
  tryReadToolStructuredError,
} from './owner.js';

/* -------------------------------------------------------------------------------------------------
 * Extended tool-call request shape (task-aware)
 * ------------------------------------------------------------------------------------------------- */

export interface ExtendedCallToolRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
    task?:
      | {
          ttl?: number | undefined;
        }
      | undefined;
    _meta?:
      | {
          progressToken?: string | number | undefined;
          'io.modelcontextprotocol/related-task'?:
            | { taskId: string }
            | undefined;
          [key: string]: unknown;
        }
      | undefined;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------------------------------
 * Abort-controller management for in-flight task executions
 * ------------------------------------------------------------------------------------------------- */

// Intentionally process-global (not session-scoped): abortAllTaskExecutions() is called
// during SIGTERM/SIGINT shutdown to cancel every in-flight task across all sessions.
// TODO: consider per-session isolation if stricter task-ownership semantics are needed.
const taskAbortControllers = new Map<string, AbortController>();

function attachAbortController(taskId: string): AbortController {
  const existing = taskAbortControllers.get(taskId);
  if (existing) {
    taskAbortControllers.delete(taskId);
  }
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller;
}

export function abortTaskExecution(taskId: string): void {
  const controller = taskAbortControllers.get(taskId);
  if (!controller) return;
  controller.abort();
  taskAbortControllers.delete(taskId);
}

function clearTaskExecution(taskId: string): void {
  taskAbortControllers.delete(taskId);
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
 * Task notification helpers
 * ------------------------------------------------------------------------------------------------- */

interface TaskStatusNotificationParams extends Record<string, unknown> {
  taskId: string;
  status: TaskState['status'];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
}

type TaskSummary = CreateTaskResult['task'];

interface RelatedTaskMeta {
  'io.modelcontextprotocol/related-task': { taskId: string };
}

export function toTaskSummary(task: {
  taskId: string;
  status: TaskState['status'];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
}): TaskSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    pollInterval: task.pollInterval,
    _meta: {
      'io.modelcontextprotocol/related-task': {
        taskId: task.taskId,
      },
    },
  };
}

export function withRelatedTaskMeta(
  result: ServerResult,
  taskId: string
): ServerResult {
  const relatedTaskMeta: RelatedTaskMeta = {
    'io.modelcontextprotocol/related-task': { taskId },
  };

  return {
    ...result,
    _meta: {
      ...result._meta,
      ...relatedTaskMeta,
    },
  };
}

export function emitTaskStatusNotification(
  server: McpServer,
  task: TaskState
): void {
  if (!server.isConnected()) return;

  // NOTE: 'notifications/tasks/status' is not part of the MCP v2025-11-25 specification.
  // This relies on the experimental task infrastructure in the SDK and may change.
  void server.server
    .notification({
      method: 'notifications/tasks/status',
      params: toTaskSummary(task),
    } as { method: string; params: TaskStatusNotificationParams })
    .catch((error: unknown) => {
      logWarn('Failed to send task status notification', {
        taskId: task.taskId,
        status: task.status,
        error,
      });
    });
}

/* -------------------------------------------------------------------------------------------------
 * Validation helpers
 * ------------------------------------------------------------------------------------------------- */

function requireFetchUrlArgs(args: unknown): FetchUrlInput {
  const parsed = fetchUrlInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid arguments for fetch-url'
    );
  }
  return parsed.data;
}

// -32002 is the MCP extension code for resource-not-found; the SDK ErrorCode enum does not export it.
const RESOURCE_NOT_FOUND_ERROR_CODE = -32002;

export function throwTaskNotFound(): never {
  throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, 'Task not found');
}

function requireFetchUrlToolName(name: string): void {
  if (name === FETCH_URL_TOOL_NAME) return;
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: '${name}'`);
}

/* -------------------------------------------------------------------------------------------------
 * Task result builders
 * ------------------------------------------------------------------------------------------------- */

function buildRelatedTaskMeta(
  taskId: string,
  meta?: ExtendedCallToolRequest['params']['_meta']
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    'io.modelcontextprotocol/related-task': { taskId },
  };
}

function buildCreateTaskResult(
  task: CreateTaskResult['task']
): CreateTaskResult {
  return {
    task,
    _meta: {
      'io.modelcontextprotocol/related-task': {
        taskId: task.taskId,
        status: task.status,
        ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
        createdAt: task.createdAt,
        lastUpdatedAt: task.lastUpdatedAt,
        ttl: task.ttl,
        pollInterval: task.pollInterval,
      },
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Execution pipeline
 * ------------------------------------------------------------------------------------------------- */

function updateWorkingTaskStatus(
  server: McpServer,
  taskId: string,
  statusMessage: string
): void {
  const current = taskManager.getTask(taskId);
  if (current?.status !== 'working') return;
  if (current.statusMessage === statusMessage) return;

  taskManager.updateTask(taskId, { statusMessage });

  const updated = taskManager.getTask(taskId);
  if (updated) emitTaskStatusNotification(server, updated);
}

async function runFetchTaskExecution(params: {
  server: McpServer;
  taskId: string;
  args: FetchUrlInput;
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { server, taskId, args, meta, sendNotification } = params;

  return runWithRequestContext(
    { requestId: taskId, operationId: taskId },
    async () => {
      const controller = attachAbortController(taskId);

      try {
        const relatedMeta = buildRelatedTaskMeta(taskId, meta);

        const result = await fetchUrlToolHandler(args, {
          signal: controller.signal,
          requestId: taskId,
          _meta: relatedMeta,
          ...compact({ sendNotification }),
          onProgress: (_progress, message) => {
            updateWorkingTaskStatus(server, taskId, message);
          },
        });

        const isToolError =
          isObject(result) &&
          typeof result['isError'] === 'boolean' &&
          result['isError'];

        taskManager.updateTask(taskId, {
          status: isToolError ? 'failed' : 'completed',
          statusMessage: isToolError
            ? (tryReadToolStructuredError(result) ?? 'Tool execution failed')
            : 'Task completed successfully.',
          result,
        });

        const task = taskManager.getTask(taskId);
        if (task) emitTaskStatusNotification(server, task);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorPayload =
          error instanceof McpError
            ? {
                code: error.code,
                message: errorMessage,
                data: error.data,
              }
            : {
                code: ErrorCode.InternalError,
                message: errorMessage,
              };

        taskManager.updateTask(taskId, {
          status: 'failed',
          statusMessage: errorMessage,
          error: errorPayload,
        });

        const task = taskManager.getTask(taskId);
        if (task) emitTaskStatusNotification(server, task);
      } finally {
        clearTaskExecution(taskId);
      }
    }
  );
}

function handleTaskToolCall(
  server: McpServer,
  params: ExtendedCallToolRequest['params'],
  context: ToolCallContext
): CreateTaskResult {
  requireFetchUrlToolName(params.name);
  const validArgs = requireFetchUrlArgs(params.arguments);

  const task = taskManager.createTask(
    params.task?.ttl !== undefined ? { ttl: params.task.ttl } : undefined,
    'Task started',
    context.ownerKey
  );

  void runFetchTaskExecution({
    server,
    taskId: task.taskId,
    args: validArgs,
    ...compact({
      meta: params._meta,
      sendNotification: context.sendNotification,
    }),
  });

  return buildCreateTaskResult(toTaskSummary(task));
}

async function handleDirectToolCall(
  params: ExtendedCallToolRequest['params'],
  context: ToolCallContext
): Promise<ServerResult> {
  const args = requireFetchUrlArgs(params.arguments);

  const extra = compact({
    signal: context.signal,
    requestId: context.requestId,
    sendNotification: context.sendNotification,
    _meta: params._meta,
  });

  return fetchUrlToolHandler(args, extra);
}

export async function handleToolCallRequest(
  server: McpServer,
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<ServerResult> {
  const { params } = request;

  if (params.task) {
    return handleTaskToolCall(server, params, context);
  }

  if (params.name === FETCH_URL_TOOL_NAME) {
    return handleDirectToolCall(params, context);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
}
