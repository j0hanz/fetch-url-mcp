import type {
  RequestId,
  Result,
  CreateTaskOptions as SdkCreateTaskOptions,
  Task,
  TaskStore,
} from '@modelcontextprotocol/server';

import { resolveMcpSessionOwnerKey } from '../lib/core.js';

import { abortTaskExecution } from './manager.js';
import { taskManager, type TaskState } from './store.js';

type SdkRequest = Parameters<TaskStore['createTask']>[2];

function resolveOwnerKey(sessionId?: string): string {
  if (!sessionId) return 'default';
  return resolveMcpSessionOwnerKey(sessionId) ?? `session:${sessionId}`;
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

export class TaskStoreAdapter implements TaskStore {
  createTask(
    taskParams: SdkCreateTaskOptions,
    _requestId: RequestId,
    _request: SdkRequest,
    sessionId?: string
  ): Promise<Task> {
    const keepAlive = taskParams.ttl ?? undefined;
    const ownerKey = resolveOwnerKey(sessionId);
    const state = taskManager.createTask(
      keepAlive !== undefined ? { keepAlive } : {},
      'Task submitted',
      ownerKey
    );
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
    result: Result
  ): Promise<void> {
    taskManager.updateTask(taskId, { status, result });
    return Promise.resolve();
  }

  getTaskResult(taskId: string): Promise<Result> {
    const state = taskManager.getTask(taskId);
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
    statusMessage?: string
  ): Promise<void> {
    taskManager.updateTask(taskId, {
      status,
      ...(statusMessage ? { statusMessage } : {}),
    });
    if (status === 'cancelled') {
      abortTaskExecution(taskId);
    }
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
