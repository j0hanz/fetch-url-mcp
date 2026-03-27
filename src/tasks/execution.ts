import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from '../lib/core.js';
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  runWithRequestContext,
} from '../lib/core.js';
import { createMcpError } from '../lib/mcp-interop.js';
import { type ProgressNotification } from '../lib/mcp-interop.js';
import { getErrorMessage } from '../lib/utils.js';
import { isObject } from '../lib/utils.js';

import {
  buildRelatedTaskMeta,
  type ExtendedCallToolRequest,
} from './call-contract.js';
import {
  type CreateTaskResult,
  taskManager,
  type TaskState,
} from './manager.js';
import {
  buildToolHandlerExtra,
  compact,
  type ToolCallContext,
  tryReadToolStructuredError,
} from './owner.js';
import {
  getTaskCapableTool,
  getTaskCapableToolSupport,
  type TaskCapableToolDescriptor,
} from './registry.js';

/* -------------------------------------------------------------------------------------------------
 * Abort-controller management for in-flight task executions
 * ------------------------------------------------------------------------------------------------- */

// Intentionally process-global (not session-scoped): abortAllTaskExecutions() is called
// during SIGTERM/SIGINT shutdown to cancel every in-flight task across all sessions.
const taskAbortControllers = new Map<string, AbortController>();

function attachAbortController(taskId: string): AbortController {
  taskAbortControllers.get(taskId)?.abort();

  if (taskAbortControllers.size >= config.tasks.maxTotal) {
    logWarn(
      'Abort controller map reached task capacity — possible leak',
      {
        size: taskAbortControllers.size,
        maxTotal: config.tasks.maxTotal,
      },
      'tasks'
    );
  }

  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller;
}

export function abortTaskExecution(taskId: string): void {
  taskAbortControllers.get(taskId)?.abort();
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
 * Task notification and validation helpers
 * ------------------------------------------------------------------------------------------------- */

type TaskSummary = CreateTaskResult['task'];
type TaskLifecycleProjection = Pick<
  TaskState,
  | 'taskId'
  | 'status'
  | 'statusMessage'
  | 'progress'
  | 'total'
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
    ...(task.progress !== undefined ? { progress: task.progress } : {}),
    ...(task.total !== undefined ? { total: task.total } : {}),
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
      params: { ...toTaskSummary(task) },
    })
    .catch((error: unknown) => {
      logError(
        'Failed to send task status notification',
        {
          taskId: task.taskId,
          status: task.status,
          error: getErrorMessage(error),
        },
        'tasks'
      );
    });
}

export function throwTaskNotFound(): never {
  throw createMcpError(ErrorCode.InvalidParams, 'Task not found');
}

/* -------------------------------------------------------------------------------------------------
 * Execution pipeline
 * ------------------------------------------------------------------------------------------------- */

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
  status: 'failed';
  statusMessage: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
} {
  const mcpErrorMessage =
    error instanceof McpError
      ? (/^MCP error -?\d+:\s*(.*)$/s.exec(error.message)?.[1] ?? error.message)
      : undefined;
  const statusMessage = mcpErrorMessage ?? getErrorMessage(error);

  if (error instanceof McpError) {
    return {
      status: 'failed',
      statusMessage,
      error: {
        code: error.code,
        ...(error.data !== undefined ? { data: error.data } : {}),
        message: statusMessage,
      },
    };
  }

  return {
    status: 'failed',
    statusMessage,
    error: {
      code: ErrorCode.InternalError,
      message: statusMessage,
    },
  };
}

function buildTaskCompletionUpdate(
  result: Awaited<ReturnType<TaskCapableToolDescriptor['execute']>>,
  tool: TaskCapableToolDescriptor
): Parameters<(typeof taskManager)['updateTask']>[1] {
  const isError =
    isObject(result) && 'isError' in result && result.isError === true;

  return {
    status: isError ? 'failed' : 'completed',
    statusMessage: isError
      ? (tryReadToolStructuredError(result) ?? 'Tool execution failed')
      : (tool.getCompletionStatusMessage?.(result) ??
        'Task completed successfully.'),
    result,
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
      const progressState = { closed: false };

      try {
        logInfo('Task execution started', { taskId, tool: tool.name }, 'tasks');
        const relatedMeta = buildRelatedTaskMeta(taskId, meta);

        const result = await tool.execute(args, {
          signal: controller.signal,
          requestId: taskId,
          _meta: relatedMeta,
          progressState,
          canReportProgress: () =>
            taskManager.getTask(taskId)?.status === 'working',
          ...compact({ sendNotification }),
          onProgress: (progress, message, total) => {
            const current = taskManager.getTask(taskId);
            if (
              current?.status === 'working' &&
              (current.statusMessage !== message ||
                current.progress !== progress ||
                (total !== undefined && current.total !== total))
            ) {
              updateTaskAndEmitStatus(server, taskId, {
                statusMessage: message,
                progress,
                ...(total !== undefined ? { total } : {}),
              });
            }
          },
        });

        const completionUpdate = buildTaskCompletionUpdate(result, tool);
        updateTaskAndEmitStatus(server, taskId, completionUpdate);
        if (completionUpdate.status === 'completed') {
          logInfo(
            'Task execution completed',
            { taskId, tool: tool.name },
            'tasks'
          );
        } else {
          logWarn(
            'Task execution completed with tool error result',
            { taskId, tool: tool.name },
            'tasks'
          );
        }
      } catch (error: unknown) {
        logError(
          'Task execution failed',
          {
            taskId,
            tool: tool.name,
            error: getErrorMessage(error),
          },
          'tasks'
        );
        updateTaskAndEmitStatus(server, taskId, buildTaskFailureState(error));
      } finally {
        progressState.closed = true;
        taskAbortControllers.delete(taskId);
      }
    }
  );
}

export async function handleToolCallRequest(
  server: McpServer,
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<ServerResult> {
  const { params } = request;

  // Validate the tool name first so an unknown tool always produces MethodNotFound
  const tool = getTaskCapableTool(server, params.name);
  if (!tool) {
    throw createMcpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: '${params.name}'`
    );
  }

  if (params.task) {
    if (getTaskCapableToolSupport(server, params.name) === 'forbidden') {
      throw createMcpError(
        ErrorCode.MethodNotFound,
        `Task augmentation is forbidden for tool '${params.name}'`
      );
    }

    const args = tool.parseArguments(params.arguments);
    const task = taskManager.createTask(
      params.task.ttl !== undefined ? { ttl: params.task.ttl } : undefined,
      'Task started',
      context.ownerKey
    );

    logInfo(
      'Task execution queued',
      {
        taskId: task.taskId,
        tool: params.name,
        ...(params.task.ttl !== undefined ? { ttl: params.task.ttl } : {}),
      },
      'tasks'
    );

    void runTaskToolExecution({
      server,
      taskId: task.taskId,
      args,
      tool,
      ...compact({
        meta: params._meta,
        sessionId: context.sessionId,
        sendNotification: context.sendNotification,
      }),
    });

    return {
      task: toTaskSummary(task),
      ...(tool.immediateResponse
        ? {
            _meta: {
              'io.modelcontextprotocol/model-immediate-response':
                tool.immediateResponse,
            },
          }
        : {}),
    };
  }

  if (getTaskCapableToolSupport(server, params.name) === 'required') {
    throw createMcpError(
      ErrorCode.MethodNotFound,
      `Task augmentation is required for tool '${params.name}'`
    );
  }

  const args = tool.parseArguments(params.arguments);
  const progressState = { closed: false };
  logDebug(
    'Executing task-capable tool inline',
    {
      tool: params.name,
      hasProgressToken: params._meta?.progressToken !== undefined,
    },
    'tasks'
  );

  try {
    return await tool.execute(args, {
      ...buildToolHandlerExtra(context, params._meta),
      progressState,
    });
  } finally {
    progressState.closed = true;
  }
}
