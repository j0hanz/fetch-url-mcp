import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerResult,
  type TaskServerContext,
} from '@modelcontextprotocol/server';

import {
  logError,
  Loggers,
  logInfo,
  logWarn,
  runWithRequestContext,
  runWithTraceContext,
} from '../lib/core.js';
import {
  getErrorMessage,
  stripProtocolErrorPrefix,
  tryReadToolErrorMessage,
} from '../lib/error/index.js';
import type { ProgressNotification } from '../lib/mcp-interop.js';
import { isObject } from '../lib/utils.js';

import {
  attachAbortController,
  buildRelatedTaskMeta,
  compact,
  detachAbortController,
  emitTaskStatusNotification,
  type TaskCapableToolDescriptor,
} from './manager.js';
import { taskManager, type TaskStatus } from './store.js';

/* ------------------------------------------------------------------------------------------------
 * SDK-compatible status mapping
 * ------------------------------------------------------------------------------------------------ */

type SdkTaskStatus = Exclude<TaskStatus, 'submitted'>;

function toSdkStatus(status: TaskStatus): SdkTaskStatus {
  return status === 'submitted' ? 'working' : status;
}

/* ------------------------------------------------------------------------------------------------
 * Task update helpers
 * ------------------------------------------------------------------------------------------------ */

function buildTaskFailureUpdate(error: unknown): {
  status: 'failed';
  statusMessage: string;
  error: { code: number; message: string; data?: unknown };
} {
  const mcpMessage =
    error instanceof ProtocolError
      ? stripProtocolErrorPrefix(error.message)
      : undefined;
  const statusMessage = mcpMessage ?? getErrorMessage(error);

  if (error instanceof ProtocolError) {
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
    error: { code: ProtocolErrorCode.InternalError, message: statusMessage },
  };
}

function buildTaskCompletionUpdate(
  result: ServerResult,
  getCompletionMessage?: (result: ServerResult) => string | undefined
): Parameters<(typeof taskManager)['updateTask']>[1] {
  const isError =
    isObject(result) && 'isError' in result && result.isError === true;
  const errorMessage = tryReadToolErrorMessage(result) ?? 'Execution failed';

  return {
    status: isError ? 'failed' : 'completed',
    statusMessage: isError
      ? errorMessage
      : (getCompletionMessage?.(result) ?? 'Task completed successfully.'),
    result,
    ...(isError
      ? {
          error: {
            code: ProtocolErrorCode.InternalError,
            message: errorMessage,
          },
        }
      : {}),
  };
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

/* ------------------------------------------------------------------------------------------------
 * ToolTaskHandler factory
 * ------------------------------------------------------------------------------------------------ */

interface CreateToolTaskHandlerOptions<T = unknown> {
  server: McpServer;
  descriptor: TaskCapableToolDescriptor<T>;
}

/**
 * Creates a ToolTaskHandler-compatible object for use with `registerToolTask`.
 *
 * The SDK parses and validates input args via the inputSchema before calling the handler,
 * so `createTask` receives already-parsed typed args. The handler delegates execution to
 * the descriptor's `execute` method in a fire-and-forget pattern.
 */
export function createToolTaskHandler<T = unknown>(
  options: CreateToolTaskHandlerOptions<T>
): {
  createTask: (
    args: T,
    ctx: CreateTaskServerContext
  ) => Promise<CreateTaskResult>;
  getTask: (args: T, ctx: TaskServerContext) => Promise<GetTaskResult>;
  getTaskResult: (args: T, ctx: TaskServerContext) => Promise<CallToolResult>;
} {
  const { server, descriptor } = options;

  return {
    createTask(
      args: T,
      ctx: CreateTaskServerContext
    ): Promise<CreateTaskResult> {
      const { sessionId } = ctx;
      const ownerKey = sessionId ?? 'default';
      const sdkNotify = ctx.mcpReq.notify;
      const sendNotification = (
        notification: ProgressNotification
      ): Promise<void> =>
        sdkNotify(notification as unknown as Parameters<typeof sdkNotify>[0]);
      const requestMeta = ctx.mcpReq._meta as
        | Record<string, unknown>
        | undefined;

      const task = taskManager.createTask({}, 'Task submitted', ownerKey);
      const { taskId } = task;

      logInfo(
        'Task execution queued',
        { taskId, tool: descriptor.name },
        Loggers.LOG_TASKS
      );

      void runTaskExecution({
        server,
        taskId,
        args,
        descriptor,
        sendNotification,
        ...(requestMeta ? { meta: requestMeta } : {}),
        ...(sessionId ? { sessionId } : {}),
      });

      return Promise.resolve({
        task: {
          taskId,
          status: toSdkStatus(task.status),
          ttl: task.keepAlive,
          createdAt: task.createdAt,
          lastUpdatedAt: task.lastUpdatedAt,
          pollInterval: task.pollFrequency,
          ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
        },
      });
    },

    getTask(_args: T, ctx: TaskServerContext): Promise<GetTaskResult> {
      const task = taskManager.getTask(ctx.task.id);
      if (!task) {
        return Promise.reject(
          new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found')
        );
      }
      return Promise.resolve({
        taskId: task.taskId,
        status: toSdkStatus(task.status),
        ttl: task.keepAlive,
        createdAt: task.createdAt,
        lastUpdatedAt: task.lastUpdatedAt,
        pollInterval: task.pollFrequency,
        ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      });
    },

    getTaskResult(_args: T, ctx: TaskServerContext): Promise<CallToolResult> {
      const task = taskManager.getTask(ctx.task.id);
      if (task?.result !== undefined && task.result !== null) {
        return Promise.resolve(task.result as CallToolResult);
      }
      return Promise.resolve({ content: [] });
    },
  };
}

async function runTaskExecution<T>(params: {
  server: McpServer;
  taskId: string;
  args: T;
  descriptor: TaskCapableToolDescriptor<T>;
  meta?: Record<string, unknown>;
  sessionId?: string;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const {
    server,
    taskId,
    args,
    descriptor,
    meta,
    sessionId,
    sendNotification,
  } = params;

  return runWithRequestContext(
    {
      requestId: taskId,
      operationId: taskId,
      ...(sessionId ? { sessionId } : {}),
    },
    () =>
      runWithTraceContext(meta, async () => {
        const controller = attachAbortController(taskId);
        const progressState = { closed: false };

        try {
          updateTaskAndEmitStatus(server, taskId, {
            status: 'working',
            statusMessage: 'Task started',
          });
          logInfo(
            'Task execution started',
            { taskId, tool: descriptor.name },
            Loggers.LOG_TASKS
          );
          const relatedMeta = buildRelatedTaskMeta(taskId, meta);

          const result = await descriptor.execute(args, {
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

          const completionUpdate = buildTaskCompletionUpdate(
            result,
            descriptor.getCompletionStatusMessage
          );
          updateTaskAndEmitStatus(server, taskId, completionUpdate);
          if (completionUpdate.status === 'completed') {
            logInfo(
              'Task execution completed',
              { taskId, tool: descriptor.name },
              Loggers.LOG_TASKS
            );
          } else {
            logWarn(
              'Task execution completed with tool error result',
              { taskId, tool: descriptor.name },
              Loggers.LOG_TASKS
            );
          }
        } catch (error: unknown) {
          logError(
            'Task execution failed',
            {
              taskId,
              tool: descriptor.name,
              error: getErrorMessage(error),
            },
            Loggers.LOG_TASKS
          );
          updateTaskAndEmitStatus(
            server,
            taskId,
            buildTaskFailureUpdate(error)
          );
        } finally {
          progressState.closed = true;
          detachAbortController(taskId);
        }
      })
  );
}
