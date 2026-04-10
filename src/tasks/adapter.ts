import type {
  RequestId,
  Result,
  CreateTaskOptions as SdkCreateTaskOptions,
  Task,
  TaskStore,
} from '@modelcontextprotocol/server';

import {
  logError,
  Loggers,
  resolveMcpSessionOwnerKey,
  resolveMcpSessionServer,
} from '../lib/core.js';

import {
  abortTaskExecution,
  emitTaskStatusNotification,
  resolveTaskOwnerKey,
  type ToolCallRequestMeta,
} from './manager.js';
import { taskManager, type TaskState } from './store.js';

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
    ttl: state.keepAlive,
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    pollInterval: state.pollFrequency,
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
      ...(taskParams.ttl !== undefined ? { keepAlive: taskParams.ttl } : {}),
      ...(taskParams.pollInterval !== undefined
        ? { pollFrequency: taskParams.pollInterval }
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
    const result =
      state?.result !== undefined && state.result !== null
        ? (state.result as Result)
        : {};
    taskManager.shrinkKeepAliveAfterDelivery(taskId);
    return Promise.resolve(result);
  }

  updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    const ownerKey = resolveOwnerKey(sessionId);
    if (!taskManager.getTask(taskId, ownerKey)) return Promise.resolve();
    taskManager.updateTask(taskId, {
      status,
      ...(statusMessage ? { statusMessage } : {}),
    });
    if (status === 'cancelled') {
      abortTaskExecution(taskId);
    }
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
