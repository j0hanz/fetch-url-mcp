import {
  ProtocolErrorCode,
  type RequestId,
  type Result,
  type CreateTaskOptions as SdkCreateTaskOptions,
  type ServerResult,
  type Task,
  type TaskStore,
} from '@modelcontextprotocol/server';

import {
  logError,
  Loggers,
  resolveMcpSessionOwnerKey,
  resolveMcpSessionServer,
} from '../lib/core.js';
import { createProtocolError } from '../lib/mcp-interop.js';

import {
  abortTaskExecution,
  emitTaskStatusNotification,
  resolveTaskOwnerKey,
  type ToolCallRequestMeta,
  withRelatedTaskMeta,
} from './manager.js';
import {
  createTerminalTaskErrorResult,
  taskManager,
  type TaskState,
} from './store.js';

type SdkRequest = Parameters<TaskStore['createTask']>[2];

function resolveOwnerKey(
  sessionId?: string,
  context?: Record<string, unknown>
): string {
  const ownerKey = context?.['ownerKey'];
  if (typeof ownerKey === 'string' && ownerKey.length > 0) return ownerKey;
  if (!sessionId) return 'default';
  return (
    resolveMcpSessionOwnerKey(sessionId) ?? resolveTaskOwnerKey({ sessionId })
  );
}

function toSdkTask(state: TaskState): Task {
  return {
    taskId: state.taskId,
    status: state.status,
    ttl: state.ttl,
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    pollInterval: state.pollInterval,
    ...(state.statusMessage ? { statusMessage: state.statusMessage } : {}),
  };
}

function readRequestMeta(request: SdkRequest): ToolCallRequestMeta | undefined {
  const meta = request.params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as ToolCallRequestMeta)
    : undefined;
}

function emitTaskStatusForSession(taskId: string, sessionId?: string): void {
  if (!sessionId) return;

  const server = resolveMcpSessionServer(sessionId);
  if (!server) return;

  const ownerKey = resolveOwnerKey(sessionId);
  const task = taskManager.getTask(taskId, ownerKey);
  if (!task) return;

  try {
    emitTaskStatusNotification(server, task);
  } catch (error: unknown) {
    logError(
      'Failed to emit task status notification',
      { taskId, error: error instanceof Error ? error.message : String(error) },
      Loggers.LOG_TASKS
    );
  }
}

function isServerResult(value: unknown): value is ServerResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>)['content'])
  );
}

function readStoredTaskResult(
  state: TaskState | undefined,
  taskId: string
): Result {
  if (!state) {
    throw createProtocolError(
      ProtocolErrorCode.ResourceNotFound,
      `Task not found: ${taskId}`
    );
  }

  if (state.result === undefined || state.result === null) {
    const terminalResult = createTerminalTaskErrorResult(state);
    if (terminalResult) {
      const result: Result = {
        ...terminalResult,
        _meta: {
          'io.modelcontextprotocol/related-task': {
            taskId,
          },
        },
      };
      return result;
    }

    throw createProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Task ${taskId} has no result stored`
    );
  }

  if (isServerResult(state.result)) {
    return withRelatedTaskMeta(state.result, taskId) as Result;
  }

  return state.result as Result;
}

export class TaskStoreAdapter implements TaskStore {
  createTask(
    taskParams: SdkCreateTaskOptions,
    requestId: RequestId,
    request: SdkRequest,
    sessionId?: string
  ): Promise<Task> {
    const ownerKey = resolveOwnerKey(sessionId, taskParams.context);
    const requestMeta = readRequestMeta(request);
    const createTaskOptions = {
      requestId: String(requestId),
      requestMethod: request.method,
      ...(taskParams.ttl !== undefined ? { ttl: taskParams.ttl } : {}),
      ...(taskParams.pollInterval !== undefined
        ? { pollInterval: taskParams.pollInterval }
        : {}),
      ...(taskParams.context ? { context: taskParams.context } : {}),
      ...(requestMeta ? { requestMeta } : {}),
    };
    const state = taskManager.createTask(
      createTaskOptions,
      'Task submitted',
      ownerKey
    );
    emitTaskStatusForSession(state.taskId, sessionId);
    return Promise.resolve(toSdkTask(state));
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const ownerKey = resolveOwnerKey(sessionId);
    const state = taskManager.getTask(taskId, ownerKey);
    return Promise.resolve(state ? toSdkTask(state) : null);
  }

  storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string
  ): Promise<void> {
    const ownerKey = resolveOwnerKey(sessionId);
    if (!taskManager.getTask(taskId, ownerKey)) return Promise.resolve();
    taskManager.updateTask(taskId, { status, result });
    emitTaskStatusForSession(taskId, sessionId);
    return Promise.resolve();
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const ownerKey = resolveOwnerKey(sessionId);
    const state = taskManager.getTask(taskId, ownerKey);
    if (state?.result !== undefined && state.result !== null) {
      const result = readStoredTaskResult(state, taskId);
      taskManager.shrinkTtlAfterDelivery(taskId);
      return Promise.resolve(result);
    }

    return taskManager
      .waitForTerminalTask(taskId, ownerKey)
      .then((terminalState) => {
        const result = readStoredTaskResult(terminalState, taskId);
        taskManager.shrinkTtlAfterDelivery(taskId);
        return result;
      });
  }

  updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    const ownerKey = resolveOwnerKey(sessionId);
    if (status === 'cancelled') {
      if (!taskManager.cancelTask(taskId, ownerKey)) return Promise.resolve();
      abortTaskExecution(taskId);
      emitTaskStatusForSession(taskId, sessionId);
      return Promise.resolve();
    }

    const task = taskManager.getTask(taskId, ownerKey);
    if (!task) return Promise.resolve();

    taskManager.updateTask(taskId, {
      status,
      ...(statusMessage ? { statusMessage } : {}),
      ...(status === 'failed'
        ? {
            result: createTerminalTaskErrorResult({
              taskId,
              status: 'failed',
              ...(statusMessage ? { statusMessage } : {}),
              ...(task.error ? { error: task.error } : {}),
            }),
          }
        : {}),
    });
    emitTaskStatusForSession(taskId, sessionId);
    return Promise.resolve();
  }

  listTasks(
    cursor?: string,
    sessionId?: string
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const ownerKey = resolveOwnerKey(sessionId);
    const result = taskManager.listTasks({
      ownerKey,
      ...(cursor ? { cursor } : {}),
    });
    return Promise.resolve({
      tasks: result.tasks.map(toSdkTask),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
}
