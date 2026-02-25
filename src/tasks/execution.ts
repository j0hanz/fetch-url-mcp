import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from '../lib/config.js';
import {
  getErrorMessage,
  RESOURCE_NOT_FOUND_ERROR_CODE,
} from '../lib/errors.js';
import { logWarn, runWithRequestContext } from '../lib/observability.js';
import type {
  ProgressNotification,
  ToolHandlerExtra,
} from '../lib/tool-progress.js';
import { isObject } from '../lib/type-guards.js';
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
import {
  getTaskCapableTool,
  hasTaskCapableTool,
  type TaskCapableToolDescriptor,
} from './tool-registry.js';

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
    // Abort the previous controller before replacing it — avoids stranding
    // a running fetch that can no longer be cancelled via abortTaskExecution().
    existing.abort();
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
  if (!config.tasks.emitStatusNotifications) return;
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

export function throwTaskNotFound(): never {
  throw new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, 'Task not found');
}

function resolveTaskCapableTool(name: string): TaskCapableToolDescriptor {
  const descriptor = getTaskCapableTool(name);
  if (descriptor) return descriptor;
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: '${name}'`);
}

// Validates that the tool name is recognized before we attempt to execute it.
// This ensures that an unknown tool produces a MethodNotFound error, rather than potentially executing and failing with an internal error if the tool handler does not properly validate its input.
function assertKnownTool(name: string): void {
  if (!hasTaskCapableTool(name)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: '${name}'`);
  }
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

function updateTaskAndEmitStatus(
  server: McpServer,
  taskId: string,
  update: Parameters<(typeof taskManager)['updateTask']>[1]
): void {
  taskManager.updateTask(taskId, update);
  const task = taskManager.getTask(taskId);
  if (task) emitTaskStatusNotification(server, task);
}

function buildTaskFailureState(error: unknown): {
  statusMessage: string;
  error: { code: number; message: string; data?: unknown };
} {
  const statusMessage = getErrorMessage(error);
  if (error instanceof McpError) {
    return {
      statusMessage,
      error: {
        code: error.code,
        message: statusMessage,
        data: error.data,
      },
    };
  }

  return {
    statusMessage,
    error: {
      code: ErrorCode.InternalError,
      message: statusMessage,
    },
  };
}

async function runTaskToolExecution(params: {
  server: McpServer;
  taskId: string;
  args: unknown;
  tool: TaskCapableToolDescriptor;
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sessionId?: string;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { server, taskId, args, tool, meta, sessionId, sendNotification } =
    params;

  return runWithRequestContext(
    {
      requestId: taskId,
      operationId: taskId,
      ...(sessionId ? { sessionId } : {}),
    },
    async () => {
      const controller = attachAbortController(taskId);

      try {
        const relatedMeta = buildRelatedTaskMeta(taskId, meta);

        const result = await tool.execute(args, {
          signal: controller.signal,
          requestId: taskId,
          _meta: relatedMeta,
          ...compact({ sendNotification }),
          onProgress: (_progress, message) => {
            updateWorkingTaskStatus(server, taskId, message);
          },
        });

        const isToolError =
          isObject(result) && 'isError' in result && result.isError === true;

        updateTaskAndEmitStatus(server, taskId, {
          status: isToolError ? 'failed' : 'completed',
          statusMessage: isToolError
            ? (tryReadToolStructuredError(result) ?? 'Tool execution failed')
            : 'Task completed successfully.',
          result,
        });
      } catch (error: unknown) {
        const failure = buildTaskFailureState(error);

        updateTaskAndEmitStatus(server, taskId, {
          status: 'failed',
          statusMessage: failure.statusMessage,
          error: failure.error,
        });
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
  const tool = resolveTaskCapableTool(params.name);
  const validArgs = tool.parseArguments(params.arguments);

  const task = taskManager.createTask(
    params.task?.ttl !== undefined ? { ttl: params.task.ttl } : undefined,
    'Task started',
    context.ownerKey
  );

  void runTaskToolExecution({
    server,
    taskId: task.taskId,
    args: validArgs,
    tool,
    ...compact({
      meta: params._meta,
      sessionId: context.sessionId,
      sendNotification: context.sendNotification,
    }),
  });

  return buildCreateTaskResult(toTaskSummary(task));
}

async function handleDirectToolCall(
  params: ExtendedCallToolRequest['params'],
  context: ToolCallContext
): Promise<ServerResult> {
  const tool = resolveTaskCapableTool(params.name);
  const args = tool.parseArguments(params.arguments);

  const extra: ToolHandlerExtra = {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.requestId !== undefined
      ? { requestId: context.requestId }
      : {}),
    ...(context.sendNotification
      ? { sendNotification: context.sendNotification }
      : {}),
    ...(params._meta ? { _meta: params._meta } : {}),
  };

  return tool.execute(args, extra);
}

export async function handleToolCallRequest(
  server: McpServer,
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<ServerResult> {
  const { params } = request;

  // Validate the tool name first so an unknown tool always produces MethodNotFound,
  // regardless of whether a task:{} param was supplied (H-4).
  assertKnownTool(params.name);

  if (params.task) {
    return handleTaskToolCall(server, params, context);
  }

  return handleDirectToolCall(params, context);
}
