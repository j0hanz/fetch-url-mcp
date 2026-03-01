import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { config } from '../lib/core.js';
import { RESOURCE_NOT_FOUND_ERROR_CODE, toError } from '../lib/utils.js';
import { type CancellableTimeout, createUnrefTimeout } from '../lib/utils.js';

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
  _ownerCounted: boolean;
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
    _meta?: {
      'io.modelcontextprotocol/related-task': {
        taskId: string;
      };
    };
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
  const rounded = Math.trunc(Number(ttl));
  if (rounded < MIN_TTL_MS) return MIN_TTL_MS;
  if (rounded > MAX_TTL_MS) return MAX_TTL_MS;
  return rounded;
}

class TaskManager {
  private tasks = new Map<string, InternalTaskState>();
  private ownerCounts = new Map<string, number>();
  private waiters = new Map<string, Set<(task: TaskState) => void>>();
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
    this.releaseOwnerCount(task);
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
    this.releaseOwnerCount(task);
  }

  private releaseOwnerCount(task: InternalTaskState | TaskState): void {
    const internal = task as Partial<InternalTaskState>;
    if (internal._ownerCounted === false) return;
    if ('_ownerCounted' in internal) {
      internal._ownerCounted = false;
    }
    this.decrementOwnerCount(task.ownerKey);
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
      _ownerCounted: true,
    };

    this.tasks.set(task.taskId, task);
    this.incrementOwnerCount(ownerKey);
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
    if (!task) return;

    if (isTerminalStatus(task.status)) return;

    this.applyTaskUpdate(task, updates);

    this.notifyWaiters(task);
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
    const decoded = this.decodeCursor(cursor);
    if (decoded === null) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }
    return decoded.anchorTaskId;
  }

  private addWaiter(taskId: string, waiter: (task: TaskState) => void): void {
    let set = this.waiters.get(taskId);
    if (!set) {
      set = new Set();
      this.waiters.set(taskId, set);
    }
    set.add(waiter);
  }

  private removeWaiter(
    taskId: string,
    waiter: ((task: TaskState) => void) | null
  ): void {
    if (!waiter) return;

    const set = this.waiters.get(taskId);
    if (!set) return;

    set.delete(waiter);
    if (set.size === 0) {
      this.waiters.delete(taskId);
    }
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return undefined;

    if (isTerminalStatus(task.status)) return task;

    // isExpired() above guarantees task.ttl has not elapsed; compute deadlineMs
    // for the promise-based timeout below.
    const deadlineMs = task._createdAtMs + task.ttl;

    return new Promise((resolve, reject) => {
      // Bind resolve/reject to the AsyncLocalStorage context of the caller, so that any context values (e.g. requestId) are preserved when we later call them from a different tick.
      const resolveInContext = AsyncLocalStorage.bind(
        (value: TaskState | undefined): void => {
          resolve(value);
        }
      );
      const rejectInContext = AsyncLocalStorage.bind((error: unknown): void => {
        reject(toError(error));
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

      const settleOnce = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const onAbort = (): void => {
        settleOnce(() => {
          cleanup();
          this.removeWaiter(taskId, waiter);
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

      this.addWaiter(taskId, waiter);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timeoutMs = Math.max(0, deadlineMs - Date.now());

      deadlineTimeout = createUnrefTimeout(timeoutMs, { timeout: true });
      void deadlineTimeout.promise
        .then(() => {
          settleOnce(() => {
            cleanup();
            this.removeWaiter(taskId, waiter);
            this.removeTask(taskId);
            rejectInContext(
              new McpError(RESOURCE_NOT_FOUND_ERROR_CODE, 'Task expired', {
                taskId,
              })
            );
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

  private encodeCursor(taskId: string): string {
    // Base64url-encode the taskId to produce a compact opaque cursor string.
    // The taskId is a UUID, which is 36 ASCII chars, so the resulting cursor will be 48 chars (36 * 4/3) plus padding if any.
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

  private resolveNextCursor(
    page: TaskState[],
    hasMore: boolean
  ): string | undefined {
    if (!hasMore) return undefined;
    const lastTask = page.at(-1);
    return lastTask ? this.encodeCursor(lastTask.taskId) : undefined;
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
