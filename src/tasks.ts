import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export type TaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

export interface TaskState {
  taskId: string;
  ownerKey: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number; // in ms
  pollInterval: number; // in ms
  result?: unknown;
  error?: TaskError;
}

export interface CreateTaskOptions {
  ttl?: number;
}

export interface CreateTaskResult {
  task: {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttl: number;
    pollInterval: number;
  };
  _meta?: Record<string, unknown>;
}

const DEFAULT_TTL_MS = 60000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_OWNER_KEY = 'default';
const DEFAULT_PAGE_SIZE = 50;

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

class TaskManager {
  private tasks = new Map<string, TaskState>();
  private waiters = new Map<string, Set<(task: TaskState) => void>>();

  createTask(
    options?: CreateTaskOptions,
    statusMessage = 'Task started',
    ownerKey: string = DEFAULT_OWNER_KEY
  ): TaskState {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const task: TaskState = {
      taskId,
      ownerKey,
      status: 'working',
      statusMessage,
      createdAt: now,
      lastUpdatedAt: now,
      ttl: options?.ttl ?? DEFAULT_TTL_MS,
      pollInterval: DEFAULT_POLL_INTERVAL_MS,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isExpired(task)) {
      this.tasks.delete(taskId);
      return undefined;
    }

    return task;
  }

  updateTask(
    taskId: string,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (updates.status && task.status !== updates.status) {
      if (isTerminalStatus(task.status)) return;
    }

    Object.assign(task, {
      ...updates,
      lastUpdatedAt: new Date().toISOString(),
    });

    this.notifyWaiters(task);
  }

  cancelTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.getTask(taskId, ownerKey);
    if (!task) return undefined;

    if (
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Cannot cancel task: already in terminal status '${task.status}'`
      );
    }

    this.updateTask(taskId, {
      status: 'cancelled',
      statusMessage: 'The task was cancelled by request.',
    });

    return this.tasks.get(taskId);
  }

  listTasks(options: { ownerKey: string; cursor?: string; limit?: number }): {
    tasks: TaskState[];
    nextCursor?: string;
  } {
    const { ownerKey, cursor, limit } = options;
    const pageSize = limit && limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const startIndex = cursor ? this.decodeCursor(cursor) : 0;

    if (startIndex === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }

    const allTasks = Array.from(this.tasks.values()).filter((task) => {
      if (task.ownerKey !== ownerKey) return false;
      if (this.isExpired(task)) {
        this.tasks.delete(task.taskId);
        return false;
      }
      return true;
    });

    const page = allTasks.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + page.length;
    const nextCursor =
      nextIndex < allTasks.length ? this.encodeCursor(nextIndex) : undefined;

    return nextCursor ? { tasks: page, nextCursor } : { tasks: page };
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    const task = this.getTask(taskId, ownerKey);
    if (!task) return undefined;
    if (isTerminalStatus(task.status)) return task;

    const createdAtMs = Date.parse(task.createdAt);
    const deadlineMs = Number.isFinite(createdAtMs)
      ? createdAtMs + task.ttl
      : Number.NaN;

    if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
      this.tasks.delete(taskId);
      return undefined;
    }

    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let waiter: ((updated: TaskState) => void) | null = null;

      const onAbort = (): void => {
        cleanup();
        removeWaiter();
        reject(
          new McpError(ErrorCode.ConnectionClosed, 'Request was cancelled')
        );
      };

      const cleanup = (): void => {
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const removeWaiter = (): void => {
        const waiters = this.waiters.get(taskId);
        if (!waiters) return;
        if (waiter) waiters.delete(waiter);
        if (waiters.size === 0) this.waiters.delete(taskId);
      };

      waiter = (updated: TaskState): void => {
        cleanup();
        resolve(updated);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      const waiters = this.waiters.get(taskId) ?? new Set();
      waiters.add(waiter);
      this.waiters.set(taskId, waiters);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (Number.isFinite(deadlineMs)) {
        const timeoutMs = Math.max(0, deadlineMs - Date.now());
        if (timeoutMs === 0) {
          cleanup();
          removeWaiter();
          this.tasks.delete(taskId);
          resolve(undefined);
          return;
        }

        timeoutId = setTimeout(() => {
          cleanup();
          removeWaiter();
          this.tasks.delete(taskId);
          resolve(undefined);
        }, timeoutMs);
      }
    });
  }

  private notifyWaiters(task: TaskState): void {
    if (!isTerminalStatus(task.status)) return;
    const waiters = this.waiters.get(task.taskId);
    if (!waiters) return;

    this.waiters.delete(task.taskId);
    for (const waiter of waiters) waiter(task);
  }

  private isExpired(task: TaskState): boolean {
    const createdAt = Date.parse(task.createdAt);
    if (!Number.isFinite(createdAt)) return false;
    return Date.now() - createdAt > task.ttl;
  }

  private encodeCursor(index: number): string {
    return Buffer.from(String(index)).toString('base64url');
  }

  private decodeCursor(cursor: string): number | null {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const value = Number.parseInt(decoded, 10);
      if (!Number.isFinite(value) || value < 0) return null;
      return value;
    } catch {
      return null;
    }
  }
}

export const taskManager = new TaskManager();
