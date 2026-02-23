import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config.js';
import { type CancellableTimeout, createUnrefTimeout } from '../timer-utils.js';

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

interface InternalTaskState extends TaskState {
  _createdAtMs: number;
}

interface CreateTaskOptions {
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

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 86_400_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OWNER_KEY = 'default';
const DEFAULT_PAGE_SIZE = 50;

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_CURSOR_LENGTH = 256;
const RESULT_DELIVERY_GRACE_MS = 10_000;

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function normalizeTaskTtl(ttl: number | undefined): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_MS;
  const rounded = Math.trunc(ttl ?? DEFAULT_TTL_MS);
  if (rounded < MIN_TTL_MS) return MIN_TTL_MS;
  if (rounded > MAX_TTL_MS) return MAX_TTL_MS;
  return rounded;
}

class TaskManager {
  private tasks = new Map<string, InternalTaskState>();
  private ownerCounts = new Map<string, number>();
  private waiters = new Map<string, Set<(task: TaskState) => void>>();

  constructor() {
    this.startCleanupLoop();
  }

  private startCleanupLoop(): void {
    const interval = setInterval(() => {
      this.removeExpiredTasks();
    }, CLEANUP_INTERVAL_MS);

    interval.unref();
  }

  private removeExpiredTasks(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, task] of this.tasks) {
      if (this.isExpired(task, now)) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      this.removeTask(id);
    }
  }

  private removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.tasks.delete(taskId);
    this.decrementOwnerCount(task.ownerKey);
    return true;
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

    if (this.tasks.size >= maxTotal) {
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
    };

    this.tasks.set(task.taskId, task);
    this.incrementOwnerCount(ownerKey);
    return task;
  }

  getTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isExpired(task)) {
      this.removeTask(taskId);
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

    if (isTerminalStatus(task.status)) return;

    Object.assign(task, {
      ...updates,
      lastUpdatedAt: new Date().toISOString(),
    });

    this.notifyWaiters(task);
  }

  cancelTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.getTask(taskId, ownerKey);
    if (!task) return undefined;

    if (isTerminalStatus(task.status)) {
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

  cancelTasksByOwner(
    ownerKey: string,
    statusMessage = 'The task was cancelled because its owner is no longer active.'
  ): TaskState[] {
    if (!ownerKey) return [];

    const cancelled: TaskState[] = [];

    for (const task of this.tasks.values()) {
      if (task.ownerKey !== ownerKey) continue;
      if (isTerminalStatus(task.status)) continue;

      this.updateTask(task.taskId, {
        status: 'cancelled',
        statusMessage,
      });

      const updated = this.tasks.get(task.taskId);
      if (updated) cancelled.push(updated);
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
    const expired: string[] = [];

    for (const task of this.tasks.values()) {
      if (task.ownerKey !== ownerKey) continue;

      if (this.isExpired(task, now)) {
        expired.push(task.taskId);
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

    for (const id of expired) {
      this.removeTask(id);
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
    let anchorTaskId: string | null = null;
    if (cursor !== undefined) {
      const decoded = this.decodeCursor(cursor);
      if (decoded === null) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
      }
      ({ anchorTaskId } = decoded);
    }

    const page = this.collectPage(ownerKey, anchorTaskId, pageSize);
    const hasMore = page.length > pageSize;
    if (hasMore) {
      page.pop();
    }

    const lastTask = page.at(-1);
    const nextCursor =
      hasMore && lastTask !== undefined
        ? this.encodeCursor(lastTask.taskId)
        : undefined;

    return nextCursor ? { tasks: page, nextCursor } : { tasks: page };
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isExpired(task)) {
      this.removeTask(taskId);
      return undefined;
    }

    if (isTerminalStatus(task.status)) return task;

    const deadlineMs = task._createdAtMs + task.ttl;
    const now = Date.now();

    if (deadlineMs <= now) {
      this.removeTask(taskId);
      return undefined;
    }

    return new Promise((resolve, reject) => {
      const resolveInContext = AsyncLocalStorage.bind(
        (value: TaskState | undefined): void => {
          resolve(value);
        }
      );
      const rejectInContext = AsyncLocalStorage.bind((error: unknown): void => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });

      let settled = false;
      let waiter: ((updated: TaskState) => void) | null = null;
      let deadlineTimeout: CancellableTimeout<{ timeout: true }> | undefined;

      const cleanup = (): void => {
        if (deadlineTimeout) {
          deadlineTimeout.cancel();
          deadlineTimeout = undefined;
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const removeWaiter = (): void => {
        if (waiter) {
          const set = this.waiters.get(taskId);
          if (set) {
            set.delete(waiter);
            if (set.size === 0) this.waiters.delete(taskId);
          }
        }
      };

      const settleOnce = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const onAbort = (): void => {
        settleOnce(() => {
          cleanup();
          removeWaiter();
          rejectInContext(
            new McpError(ErrorCode.ConnectionClosed, 'Request was cancelled')
          );
        });
      };

      waiter = (updated: TaskState): void => {
        settleOnce(() => {
          cleanup();
          if (updated.ownerKey !== ownerKey) {
            resolveInContext(undefined);
            return;
          }
          resolveInContext(updated);
        });
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      let set = this.waiters.get(taskId);
      if (!set) {
        set = new Set();
        this.waiters.set(taskId, set);
      }
      set.add(waiter);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutMs = Math.max(0, deadlineMs - Date.now());

      deadlineTimeout = createUnrefTimeout(timeoutMs, { timeout: true });
      void deadlineTimeout.promise
        .then(() => {
          settleOnce(() => {
            cleanup();
            removeWaiter();
            this.removeTask(taskId);
            resolveInContext(undefined);
          });
        })
        .catch(rejectInContext);
    });
  }

  private notifyWaiters(task: TaskState): void {
    if (!isTerminalStatus(task.status)) return;

    const waiters = this.waiters.get(task.taskId);
    if (!waiters) return;

    this.waiters.delete(task.taskId);
    for (const waiter of waiters) waiter(task);
  }

  private isExpired(task: InternalTaskState, now = Date.now()): boolean {
    return now - task._createdAtMs > task.ttl;
  }

  shrinkTtlAfterDelivery(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (!isTerminalStatus(task.status)) return;

    const elapsed = Date.now() - task._createdAtMs;
    const newTtl = elapsed + RESULT_DELIVERY_GRACE_MS;
    if (newTtl < task.ttl) {
      task.ttl = newTtl;
    }
  }

  private encodeCursor(taskId: string): string {
    return Buffer.from(taskId, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { anchorTaskId: string } | null {
    try {
      if (!isValidBase64UrlCursor(cursor)) return null;
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      // Basic sanity: non-empty and plausible taskId length (UUIDs are 36 chars)
      if (!decoded || decoded.length > 128) return null;
      return { anchorTaskId: decoded };
    } catch {
      return null;
    }
  }
}

function isValidBase64UrlCursor(cursor: string): boolean {
  if (!cursor) return false;
  if (cursor.length > MAX_CURSOR_LENGTH) return false;
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(cursor)) return false;
  const firstPaddingIndex = cursor.indexOf('=');
  if (firstPaddingIndex !== -1) {
    for (let i = firstPaddingIndex; i < cursor.length; i += 1) {
      if (cursor[i] !== '=') return false;
    }
    return cursor.length % 4 === 0;
  }
  return cursor.length % 4 !== 1;
}

export const taskManager = new TaskManager();
