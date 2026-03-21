import { randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { config, logWarn } from '../lib/core.js';

import { decodeTaskCursor, encodeTaskCursor } from './cursor-codec.js';
import {
  TaskWaiterRegistry,
  waitForTerminalTask as waitForTerminalTaskWithDeadline,
} from './waiters.js';

export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';

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

interface InternalTaskState extends TaskState {
  _createdAtMs: number;
  _capacityCounted: boolean;
}

interface CreateTaskOptions {
  ttl?: number;
}

export interface CreateTaskResult {
  [key: string]: unknown;
  task: {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttl: number;
    pollInterval: number;
  };
}

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 86_400_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OWNER_KEY = 'default';
const DEFAULT_PAGE_SIZE = 50;

const CLEANUP_INTERVAL_MS = 60_000;
const RESULT_DELIVERY_GRACE_MS = 10_000;
const TASK_STATUS_VALUES = new Set<TaskStatus>([
  'working',
  'completed',
  'failed',
  'cancelled',
]);
const TASK_STATUS_TRANSITIONS: Readonly<
  Record<TaskStatus, ReadonlySet<TaskStatus>>
> = {
  working: new Set(['working', 'completed', 'failed', 'cancelled']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
};

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' && TASK_STATUS_VALUES.has(value as TaskStatus)
  );
}

function resolveNextTaskStatus(
  task: TaskState,
  updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
): TaskStatus {
  const nextStatus = updates.status;
  if (nextStatus === undefined) return task.status;

  if (!isTaskStatus(nextStatus)) {
    throw new McpError(
      ErrorCode.InternalError,
      `Invalid task status '${String(nextStatus)}'`
    );
  }

  const allowedTransitions = TASK_STATUS_TRANSITIONS[task.status];
  if (!allowedTransitions.has(nextStatus)) {
    throw new McpError(
      ErrorCode.InternalError,
      `Invalid task status transition: '${task.status}' -> '${nextStatus}'`
    );
  }

  return nextStatus;
}

function normalizeTaskTtl(ttl: number | undefined): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_MS;
  const rounded = Math.trunc(Number(ttl));
  if (rounded < MIN_TTL_MS) return MIN_TTL_MS;
  if (rounded > MAX_TTL_MS) return MAX_TTL_MS;
  return rounded;
}

class TaskManager {
  private tasks = new Map<string, InternalTaskState>();
  private activeTaskCount = 0;
  private ownerCounts = new Map<string, number>();
  private readonly waiters = new TaskWaiterRegistry<InternalTaskState>(
    isTerminalStatus
  );
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private ensureCleanupLoop(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.removeExpiredTasks();
      if (this.tasks.size === 0) {
        this.stopCleanupLoop();
      }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  private stopCleanupLoop(): void {
    if (!this.cleanupInterval) return;
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }

  private removeExpiredTasks(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (this.isExpired(task, now)) {
        this.removeTask(id);
      }
    }
  }

  private removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
    return true;
  }

  private applyTaskUpdate(
    task: InternalTaskState,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    Object.assign(task, updates);
    task.lastUpdatedAt = new Date().toISOString();
  }

  private cancelActiveTask(
    task: InternalTaskState,
    statusMessage: string
  ): void {
    this.applyTaskUpdate(task, {
      status: 'cancelled',
      statusMessage,
    });
    this.notifyWaiters(task);
    this.releaseTaskCapacity(task);
  }

  private decrementActiveTaskCount(): void {
    if (this.activeTaskCount === 0) return;
    this.activeTaskCount -= 1;
  }

  private releaseTaskCapacity(task: InternalTaskState | TaskState): void {
    const internal = task as Partial<InternalTaskState>;
    if (internal._capacityCounted === false) return;
    if ('_capacityCounted' in internal) {
      internal._capacityCounted = false;
    }
    this.decrementOwnerCount(task.ownerKey);
    this.decrementActiveTaskCount();
  }

  private countTasksForOwner(ownerKey: string): number {
    return this.ownerCounts.get(ownerKey) ?? 0;
  }

  private incrementOwnerCount(ownerKey: string): void {
    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1);
  }

  private decrementOwnerCount(ownerKey: string): void {
    const previousCount = this.ownerCounts.get(ownerKey) ?? 0;
    if (previousCount > 1) {
      this.ownerCounts.set(ownerKey, previousCount - 1);
      return;
    }
    this.ownerCounts.delete(ownerKey);
  }

  private assertTaskCapacity(ownerKey: string): void {
    const { maxPerOwner, maxTotal } = config.tasks;

    if (this.activeTaskCount >= maxTotal) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Task capacity reached (${maxTotal} total tasks)`
      );
    }

    const ownerCount = this.countTasksForOwner(ownerKey);
    if (ownerCount >= maxPerOwner) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Task capacity reached for owner (${maxPerOwner} tasks)`
      );
    }
  }

  createTask(
    options?: CreateTaskOptions,
    statusMessage = 'Task started',
    ownerKey: string = DEFAULT_OWNER_KEY
  ): TaskState {
    this.removeExpiredTasks();
    this.assertTaskCapacity(ownerKey);

    const now = new Date();
    const createdAt = now.toISOString();

    const task: InternalTaskState = {
      taskId: randomUUID(),
      ownerKey,
      status: 'working',
      statusMessage,
      createdAt,
      lastUpdatedAt: createdAt,
      ttl: normalizeTaskTtl(options?.ttl),
      pollInterval: DEFAULT_POLL_INTERVAL_MS,
      _createdAtMs: now.getTime(),
      _capacityCounted: true,
    };

    this.tasks.set(task.taskId, task);
    this.incrementOwnerCount(ownerKey);
    this.activeTaskCount += 1;
    this.ensureCleanupLoop();
    return task;
  }

  private lookupActiveTask(
    taskId: string,
    ownerKey?: string
  ): InternalTaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isExpired(task)) {
      this.removeTask(taskId);
      return undefined;
    }

    return task;
  }

  getTask(taskId: string, ownerKey?: string): TaskState | undefined {
    return this.lookupActiveTask(taskId, ownerKey);
  }

  updateTask(
    taskId: string,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      logWarn('updateTask called for unknown task', { taskId });
      return;
    }

    if (isTerminalStatus(task.status)) {
      logWarn('updateTask called for terminal task', {
        taskId,
        currentStatus: task.status,
      });
      return;
    }

    const nextStatus = resolveNextTaskStatus(task, updates);

    this.applyTaskUpdate(task, {
      ...updates,
      ...(updates.status === undefined ? {} : { status: nextStatus }),
    });

    this.notifyWaiters(task);
    if (isTerminalStatus(nextStatus)) {
      this.releaseTaskCapacity(task);
    }
  }

  cancelTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return undefined;

    if (isTerminalStatus(task.status)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Cannot cancel task: already in terminal status '${task.status}'`
      );
    }

    this.cancelActiveTask(task, 'The task was cancelled by request.');

    return this.tasks.get(taskId);
  }

  cancelTasksByOwner(
    ownerKey: string,
    statusMessage = 'The task was cancelled because its owner is no longer active.'
  ): TaskState[] {
    if (!ownerKey) return [];

    const cancelled: TaskState[] = [];

    for (const task of this.tasks.values()) {
      if (task.ownerKey !== ownerKey) continue;
      if (isTerminalStatus(task.status)) continue;

      this.cancelActiveTask(task, statusMessage);
      cancelled.push(task);
    }

    return cancelled;
  }

  private collectPage(
    ownerKey: string,
    anchorTaskId: string | null,
    pageSize: number
  ): TaskState[] {
    const page: TaskState[] = [];
    let collecting = anchorTaskId === null;
    let anchorFound = anchorTaskId === null;
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.ownerKey !== ownerKey) continue;

      if (this.isExpired(task, now)) {
        this.removeTask(task.taskId);
        continue;
      }

      if (!collecting) {
        if (task.taskId === anchorTaskId) {
          anchorFound = true;
          collecting = true;
        }
        continue;
      }

      page.push(task);
      if (page.length > pageSize) break;
    }

    // Anchor task expired between pages; return empty list so callers stop
    // pagination cleanly. Silently falling back to page 0 risks infinite loops
    // for automated clients that always follow nextCursor.
    if (!anchorFound) {
      return [];
    }

    return page;
  }

  listTasks(options: { ownerKey: string; cursor?: string; limit?: number }): {
    tasks: TaskState[];
    nextCursor?: string;
  } {
    const { ownerKey, cursor, limit } = options;

    const pageSize = limit && limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const anchorTaskId = this.resolveAnchorTaskId(cursor);

    const page = this.collectPage(ownerKey, anchorTaskId, pageSize);
    const hasMore = page.length > pageSize;
    if (hasMore) {
      page.pop();
    }

    const nextCursor = this.resolveNextCursor(page, hasMore);

    return nextCursor ? { tasks: page, nextCursor } : { tasks: page };
  }

  private resolveAnchorTaskId(cursor?: string): string | null {
    if (cursor === undefined) return null;
    const decoded = decodeTaskCursor(cursor);
    if (decoded === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }
    return decoded.anchorTaskId;
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    return waitForTerminalTaskWithDeadline({
      taskId,
      ownerKey,
      ...(signal ? { signal } : {}),
      lookupTask: (currentTaskId, currentOwnerKey) =>
        this.lookupActiveTask(currentTaskId, currentOwnerKey),
      removeTask: (currentTaskId) => {
        this.removeTask(currentTaskId);
      },
      registry: this.waiters,
      isTerminalStatus,
    });
  }

  private notifyWaiters(task: TaskState): void {
    this.waiters.notify(task as InternalTaskState);
  }

  private isExpired(task: InternalTaskState, now = Date.now()): boolean {
    return now - task._createdAtMs > task.ttl;
  }

  private maybeUpdateLastUpdatedAt(task: InternalTaskState): void {
    task.lastUpdatedAt = new Date().toISOString();
  }

  shrinkTtlAfterDelivery(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (!isTerminalStatus(task.status)) return;

    const elapsed = Date.now() - task._createdAtMs;
    const newTtl = elapsed + RESULT_DELIVERY_GRACE_MS;
    if (newTtl < task.ttl) {
      task.ttl = newTtl;
      this.maybeUpdateLastUpdatedAt(task);
    }
  }

  private resolveNextCursor(
    page: TaskState[],
    hasMore: boolean
  ): string | undefined {
    if (!hasMore) return undefined;
    const lastTask = page.at(-1);
    return lastTask ? encodeTaskCursor(lastTask.taskId) : undefined;
  }
}

export const taskManager = new TaskManager();
