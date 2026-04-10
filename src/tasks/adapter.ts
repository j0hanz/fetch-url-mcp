import type {
  RequestId,
  Result,
  CreateTaskOptions as SdkCreateTaskOptions,
  Task,
  TaskStore,
} from '@modelcontextprotocol/server';

import { taskManager, type TaskState } from './store.js';

type SdkRequest = Parameters<TaskStore['createTask']>[2];

function toSdkTask(state: TaskState): Task {
  return {
    taskId: state.taskId,
    status: state.status === 'submitted' ? 'working' : state.status,
    ttl: state.keepAlive,
    createdAt: state.createdAt,
    lastUpdatedAt: state.lastUpdatedAt,
    pollInterval: state.pollFrequency,
    ...(state.statusMessage ? { statusMessage: state.statusMessage } : {}),
  };
}

export class TaskStoreAdapter implements TaskStore {
  private results = new Map<string, Result>();

  createTask(
    taskParams: SdkCreateTaskOptions,
    _requestId: RequestId,
    _request: SdkRequest,
    sessionId?: string
  ): Promise<Task> {
    const keepAlive = taskParams.ttl ?? undefined;
    const state = taskManager.createTask(
      keepAlive !== undefined ? { keepAlive } : {},
      'Task submitted',
      sessionId ?? 'default'
    );
    return Promise.resolve(toSdkTask(state));
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const state = taskManager.getTask(taskId, sessionId);
    return Promise.resolve(state ? toSdkTask(state) : null);
  }

  storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result
  ): Promise<void> {
    this.results.set(taskId, result);
    taskManager.updateTask(taskId, { status });
    return Promise.resolve();
  }

  getTaskResult(taskId: string): Promise<Result> {
    const stored = this.results.get(taskId);
    if (stored) return Promise.resolve(stored);

    const state = taskManager.getTask(taskId);
    if (state?.result) return Promise.resolve(state.result as Result);

    return Promise.resolve({});
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
    return Promise.resolve();
  }

  listTasks(
    cursor?: string,
    sessionId?: string
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const result = taskManager.listTasks({
      ownerKey: sessionId ?? 'default',
      ...(cursor ? { cursor } : {}),
    });
    return Promise.resolve({
      tasks: result.tasks.map(toSdkTask),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  }
}
