import { ProtocolErrorCode, SdkErrorCode } from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { config } from '../lib/config.js';
import { Loggers, logInfo, logWarn } from '../lib/core.js';
import { toError } from '../lib/error/index.js';
import { createProtocolError } from '../lib/mcp-interop.js';
import {
  type CancellableTimeout,
  createUnrefTimeout,
  isObject,
  timingSafeEqualUtf8,
} from '../lib/utils.js';

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
  keepAlive: number | null;
  pollFrequency: number;
  result?: unknown;
  error?: TaskError;
  requestId?: string;
  requestMethod?: string;
  requestMeta?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

interface InternalTaskState extends TaskState {
  _createdAtMs: number;
  _terminalAtMs?: number;
}

interface CreateTaskOptions {
  taskId?: string;
  keepAlive?: number | null;
  pollFrequency?: number;
  requestId?: string;
  requestMethod?: string;
  requestMeta?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface CreateTaskResult {
  [key: string]: unknown;
  task: {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    keepAlive: number | null;
    pollFrequency: number;
    ttl: number | null;
    pollInterval: number;
  };
}

interface TerminalTaskErrorResult {
  content: [{ type: 'text'; text: string }];
  isError: true;
}

const DEFAULT_KEEP_ALIVE_MS = 60_000;
const MIN_KEEP_ALIVE_MS = 1_000;
const MAX_KEEP_ALIVE_MS = 86_400_000;
const DEFAULT_POLL_FREQUENCY_MS = 1_000;
const DEFAULT_OWNER_KEY = 'default';
const DEFAULT_PAGE_SIZE = 50;

const CLEANUP_INTERVAL_MS = 60_000;
const RESULT_DELIVERY_GRACE_MS = 10_000;
const CONNECTION_CLOSED_ERROR_CODE = -32000;
const TASK_STATUS_VALUES = new Set<TaskStatus>([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function createTerminalTaskErrorResult(
  task: Pick<TaskState, 'taskId' | 'status' | 'statusMessage' | 'error'>
): TerminalTaskErrorResult | undefined {
  if (task.status !== 'cancelled' && task.status !== 'failed') {
    return undefined;
  }

  const message =
    task.statusMessage ??
    (task.status === 'cancelled' ? 'The task was cancelled.' : 'Task failed.');
  const payload: Record<string, unknown> = {
    error: message,
    taskId: task.taskId,
    status: task.status,
  };

  if (task.error?.code !== undefined) payload['code'] = task.error.code;
  if (task.error?.data !== undefined) payload['data'] = task.error.data;

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function resolveNextTaskStatus(
  task: TaskState,
  updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
): TaskStatus {
  const nextStatus = updates.status;
  if (!nextStatus || nextStatus === task.status) return task.status;

  if (!TASK_STATUS_VALUES.has(nextStatus)) {
    throw createProtocolError(
      ProtocolErrorCode.InternalError,
      `Invalid task status: ${nextStatus}`
    );
  }

  if (isTerminalStatus(task.status)) {
    throw createProtocolError(
      ProtocolErrorCode.InternalError,
      `Cannot transition task from ${task.status} to ${nextStatus}`
    );
  }

  return nextStatus;
}

function normalizeKeepAlive(keepAlive: number | undefined): number {
  if (keepAlive === undefined || !Number.isFinite(keepAlive)) {
    return DEFAULT_KEEP_ALIVE_MS;
  }
  return Math.max(
    MIN_KEEP_ALIVE_MS,
    Math.min(Math.trunc(keepAlive), MAX_KEEP_ALIVE_MS)
  );
}

function normalizeOptionalKeepAlive(
  keepAlive: number | null | undefined
): number | null {
  if (keepAlive === null) return null;
  return normalizeKeepAlive(keepAlive);
}

function normalizePollFrequency(pollFrequency: number | undefined): number {
  if (pollFrequency === undefined || !Number.isFinite(pollFrequency)) {
    return DEFAULT_POLL_FREQUENCY_MS;
  }
  return Math.max(1, Math.trunc(pollFrequency));
}

function logTaskStatusTransition(
  task: TaskState,
  previousStatus: TaskStatus,
  nextStatus: TaskStatus
): void {
  if (previousStatus === nextStatus) return;

  const meta = {
    taskId: task.taskId,
    ownerKey: task.ownerKey,
    previousStatus,
    nextStatus,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
  };

  if (nextStatus === 'failed') {
    logWarn('Task status changed to failed', meta, Loggers.LOG_TASKS);
    return;
  }

  logInfo('Task status changed', meta, Loggers.LOG_TASKS);
}

class TaskManager {
  private tasks = new Map<string, InternalTaskState>();
  private ownerCounts = new Map<string, number>();
  private readonly waiters = new TaskWaiterRegistry<InternalTaskState>(
    isTerminalStatus
  );
  private readonly statusListeners = new Set<(task: TaskState) => void>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private ensureCleanupLoop(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.removeExpiredTasks();
      if (this.tasks.size === 0) this.stopCleanupLoop();
    }, CLEANUP_INTERVAL_MS).unref();
  }

  private stopCleanupLoop(): void {
    if (!this.cleanupInterval) return;
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }

  private isTaskExpired(task: InternalTaskState, nowMs: number): boolean {
    if (task.keepAlive === null) return false;
    if (task._terminalAtMs !== undefined) {
      return nowMs - task._terminalAtMs > task.keepAlive;
    }
    return nowMs - task._createdAtMs > MAX_KEEP_ALIVE_MS;
  }

  private removeExpiredTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!this.isTaskExpired(task, now)) continue;
      logWarn(
        'Task expired',
        {
          taskId: task.taskId,
          ownerKey: task.ownerKey,
          status: task.status,
        },
        Loggers.LOG_TASKS
      );
      this.removeTask(task.taskId);
    }
  }

  private removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (!isTerminalStatus(task.status)) {
      this.applyTaskUpdate(task, {
        status: 'failed',
        statusMessage: 'Task removed due to expiration',
      });
      this.emitStatus(task);
      this.waiters.notify(task);
    }

    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
  }

  private applyTaskUpdate(
    task: InternalTaskState,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    Object.assign(task, updates);
    task.lastUpdatedAt = new Date().toISOString();
    if (
      updates.status &&
      isTerminalStatus(updates.status) &&
      task._terminalAtMs === undefined
    ) {
      task._terminalAtMs = Date.now();
    }
  }

  private cancelActiveTask(
    task: InternalTaskState,
    statusMessage: string
  ): void {
    const error = {
      code: CONNECTION_CLOSED_ERROR_CODE,
      message: statusMessage,
      data: { code: 'ABORTED', sdkCode: SdkErrorCode.ConnectionClosed },
    };
    this.applyTaskUpdate(task, {
      status: 'cancelled',
      statusMessage,
      error,
      result: createTerminalTaskErrorResult({
        taskId: task.taskId,
        status: 'cancelled',
        statusMessage,
        error,
      }),
    });
    this.emitStatus(task);
    this.waiters.notify(task);
  }

  private emitStatus(task: InternalTaskState): void {
    for (const listener of this.statusListeners) listener(task);
  }

  onStatusChange(listener: (task: TaskState) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private releaseTaskCapacity(task: InternalTaskState | TaskState): void {
    const nextCount = (this.ownerCounts.get(task.ownerKey) ?? 0) - 1;
    if (nextCount > 0) {
      this.ownerCounts.set(task.ownerKey, nextCount);
      return;
    }
    this.ownerCounts.delete(task.ownerKey);
  }

  private reserveTaskCapacity(ownerKey: string): void {
    const { maxPerOwner, maxTotal } = config.tasks;

    if (this.tasks.size >= maxTotal) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Server task limit reached (${maxTotal})`
      );
    }

    if ((this.ownerCounts.get(ownerKey) ?? 0) >= maxPerOwner) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Task limit reached for this session (${maxPerOwner})`
      );
    }

    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1);
  }

  createTask(
    options?: CreateTaskOptions,
    statusMessage = 'Task submitted',
    ownerKey: string = DEFAULT_OWNER_KEY
  ): TaskState {
    this.removeExpiredTasks();

    const taskId = options?.taskId ?? randomUUID();
    if (this.tasks.has(taskId)) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Task already exists: ${taskId}`
      );
    }

    this.reserveTaskCapacity(ownerKey);

    const now = new Date();
    const createdAt = now.toISOString();
    const task: InternalTaskState = {
      taskId,
      ownerKey,
      status: 'working',
      statusMessage,
      createdAt,
      lastUpdatedAt: createdAt,
      keepAlive: normalizeOptionalKeepAlive(options?.keepAlive),
      pollFrequency: normalizePollFrequency(options?.pollFrequency),
      ...(options?.requestId ? { requestId: options.requestId } : {}),
      ...(options?.requestMethod
        ? { requestMethod: options.requestMethod }
        : {}),
      ...(options?.requestMeta ? { requestMeta: options.requestMeta } : {}),
      ...(options?.context ? { context: options.context } : {}),
      _createdAtMs: now.getTime(),
    };

    this.tasks.set(task.taskId, task);
    this.ensureCleanupLoop();
    logInfo(
      'Task created',
      {
        taskId: task.taskId,
        ownerKey,
        keepAlive: task.keepAlive,
        pollFrequency: task.pollFrequency,
      },
      Loggers.LOG_TASKS
    );
    this.emitStatus(task);
    return task;
  }

  private lookupActiveTask(
    taskId: string,
    ownerKey?: string
  ): InternalTaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isTaskExpired(task, Date.now())) {
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
      logWarn(
        'updateTask called for unknown task',
        { taskId },
        Loggers.LOG_TASKS
      );
      return;
    }
    if (isTerminalStatus(task.status)) {
      logWarn(
        'updateTask called for terminal task',
        {
          taskId,
          currentStatus: task.status,
        },
        Loggers.LOG_TASKS
      );
      return;
    }

    const nextStatus = resolveNextTaskStatus(task, updates);
    const previousStatus = task.status;

    this.applyTaskUpdate(task, {
      ...updates,
      ...(updates.status === undefined ? {} : { status: nextStatus }),
    });

    logTaskStatusTransition(task, previousStatus, task.status);
    this.emitStatus(task);
    this.waiters.notify(task);
  }

  cancelTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return undefined;

    if (isTerminalStatus(task.status)) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Cannot cancel task: already ${task.status}`
      );
    }

    this.cancelActiveTask(task, 'The task was cancelled by request.');
    logInfo(
      'Task cancelled by request',
      {
        taskId: task.taskId,
        ownerKey: task.ownerKey,
      },
      Loggers.LOG_TASKS
    );
    return task;
  }

  deleteTask(taskId: string, ownerKey?: string): boolean {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return false;

    if (!isTerminalStatus(task.status)) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Cannot delete task: status is ${task.status}`
      );
    }

    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
    logInfo(
      'Task deleted by request',
      { taskId: task.taskId, ownerKey: task.ownerKey },
      Loggers.LOG_TASKS
    );
    return true;
  }

  cancelTasksByOwner(
    ownerKey: string,
    statusMessage = 'The task was cancelled because its owner is no longer active.'
  ): TaskState[] {
    if (!ownerKey) return [];

    const cancelled: TaskState[] = [];
    for (const task of this.tasks.values()) {
      if (task.ownerKey !== ownerKey || isTerminalStatus(task.status)) continue;
      this.cancelActiveTask(task, statusMessage);
      cancelled.push(task);
    }

    if (cancelled.length > 0) {
      logInfo(
        'Tasks cancelled for owner',
        {
          ownerKey,
          count: cancelled.length,
        },
        Loggers.LOG_TASKS
      );
    }
    return cancelled;
  }

  private collectPage(
    ownerKey: string,
    anchorTaskId: string | null,
    pageSize: number
  ): TaskState[] {
    const now = Date.now();
    const validTasks = Array.from(this.tasks.values()).filter((task) => {
      if (task.ownerKey !== ownerKey) return false;
      if (!this.isTaskExpired(task, now)) return true;
      this.removeTask(task.taskId);
      return false;
    });

    if (anchorTaskId === null) {
      return validTasks.slice(0, pageSize + 1);
    }

    const anchorIndex = validTasks.findIndex(
      (task) => task.taskId === anchorTaskId
    );
    if (anchorIndex === -1) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Invalid cursor'
      );
    }

    return validTasks.slice(anchorIndex + 1, anchorIndex + 1 + pageSize + 1);
  }

  listTasks(options: { ownerKey: string; cursor?: string; limit?: number }): {
    tasks: TaskState[];
    nextCursor?: string;
  } {
    const limit =
      options.limit && options.limit > 0 ? options.limit : DEFAULT_PAGE_SIZE;
    const anchorTaskId = this.resolveAnchorTaskId(options.cursor);
    const page = this.collectPage(options.ownerKey, anchorTaskId, limit);
    const hasMore = page.length > limit;
    if (hasMore) page.pop();

    const lastTask = page.at(-1);
    const nextCursor =
      hasMore && lastTask ? encodeTaskCursor(lastTask.taskId) : undefined;

    return nextCursor ? { tasks: page, nextCursor } : { tasks: page };
  }

  private resolveAnchorTaskId(cursor?: string): string | null {
    if (!cursor) return null;
    const decoded = decodeTaskCursor(cursor);
    if (!decoded) {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Invalid cursor'
      );
    }
    return decoded.anchorTaskId;
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    return waitForTerminalTask({
      taskId,
      ownerKey,
      ...(signal ? { signal } : {}),
      lookupTask: (id: string, owner: string) =>
        this.lookupActiveTask(id, owner),
      removeTask: (id: string) => {
        this.removeTask(id);
      },
      registry: this.waiters,
      isTerminalStatus,
    });
  }

  shrinkKeepAliveAfterDelivery(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || !isTerminalStatus(task.status)) return;
    if (task.keepAlive === null) return;

    if (RESULT_DELIVERY_GRACE_MS < task.keepAlive) {
      task.keepAlive = RESULT_DELIVERY_GRACE_MS;
      task.lastUpdatedAt = new Date().toISOString();
    }
  }
}

const MAX_CURSOR_LENGTH = 256;
const MAX_ANCHOR_ID_LENGTH = 128;
const CURSOR_SECRET = randomBytes(32);

function signPayload(payload: string): string {
  return createHmac('sha256', CURSOR_SECRET)
    .update(payload)
    .digest('base64url');
}

export function encodeTaskCursor(anchorTaskId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ anchorTaskId }),
    'utf8'
  ).toString('base64url');
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

function validateDecodedPayload(
  decoded: unknown
): { anchorTaskId: string } | null {
  if (!isObject(decoded)) return null;

  const { anchorTaskId } = decoded;
  if (
    typeof anchorTaskId !== 'string' ||
    anchorTaskId.length === 0 ||
    anchorTaskId.length > MAX_ANCHOR_ID_LENGTH
  ) {
    return null;
  }

  return { anchorTaskId };
}

export function decodeTaskCursor(
  cursor: string
): { anchorTaskId: string } | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) return null;

  const [payload, signature, ...rest] = cursor.split('.');
  if (!payload || !signature || rest.length > 0) return null;
  if (!timingSafeEqualUtf8(signPayload(payload), signature)) return null;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    return validateDecodedPayload(decoded);
  } catch {
    return null;
  }
}

interface WaitableTask {
  taskId: string;
  ownerKey: string;
  status: string;
  keepAlive: number | null;
  _createdAtMs: number;
}

type TaskWaiter<TTask extends WaitableTask> = (task: TTask) => void;

export class TaskWaiterRegistry<TTask extends WaitableTask> {
  private waiters = new Map<string, Set<TaskWaiter<TTask>>>();

  constructor(
    private readonly isTerminalStatus: (status: TTask['status']) => boolean
  ) {}

  add(taskId: string, waiter: TaskWaiter<TTask>): void {
    let set = this.waiters.get(taskId);
    if (!set) {
      set = new Set();
      this.waiters.set(taskId, set);
    }
    set.add(waiter);
  }

  remove(taskId: string, waiter: TaskWaiter<TTask> | null): void {
    if (!waiter) return;

    const set = this.waiters.get(taskId);
    if (!set) return;

    set.delete(waiter);
    if (set.size === 0) {
      this.waiters.delete(taskId);
    }
  }

  notify(task: TTask): void {
    if (!this.isTerminalStatus(task.status)) return;

    const waiters = this.waiters.get(task.taskId);
    if (!waiters) return;

    this.waiters.delete(task.taskId);
    for (const waiter of waiters) waiter(task);
  }
}

export async function waitForTerminalTask<TTask extends WaitableTask>(options: {
  taskId: string;
  ownerKey: string;
  signal?: AbortSignal;
  lookupTask: (taskId: string, ownerKey: string) => TTask | undefined;
  removeTask: (taskId: string) => void;
  registry: TaskWaiterRegistry<TTask>;
  isTerminalStatus: (status: TTask['status']) => boolean;
}): Promise<TTask | undefined> {
  const task = options.lookupTask(options.taskId, options.ownerKey);
  if (!task) return undefined;
  if (options.isTerminalStatus(task.status)) return task;
  return createWaitForTaskPromise(
    options,
    task.keepAlive === null ? null : task._createdAtMs + task.keepAlive
  );
}

// eslint-disable-next-line sonarjs/no-invariant-returns -- this helper intentionally returns the shared pending promise it wires up below.
function createWaitForTaskPromise<TTask extends WaitableTask>(
  options: {
    taskId: string;
    ownerKey: string;
    signal?: AbortSignal;
    lookupTask: (taskId: string, ownerKey: string) => TTask | undefined;
    removeTask: (taskId: string) => void;
    registry: TaskWaiterRegistry<TTask>;
    isTerminalStatus: (status: TTask['status']) => boolean;
  },
  deadlineMs: number | null
): Promise<TTask | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<
    TTask | undefined
  >();
  const resolveInContext = AsyncLocalStorage.bind(
    (value: TTask | undefined): void => {
      resolve(value);
    }
  );
  const rejectInContext = AsyncLocalStorage.bind((error: unknown): void => {
    reject(toError(error));
  });

  let settled = false;
  let waiter: TaskWaiter<TTask> | null = null;
  let deadlineTimeout: CancellableTimeout<{ timeout: true }> | undefined;

  const cleanup = (): void => {
    if (deadlineTimeout) {
      deadlineTimeout.cancel();
      deadlineTimeout = undefined;
    }
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
  };

  const settleOnce = (fn: () => void): void => {
    if (!settled) {
      settled = true;
      fn();
    }
  };

  const onAbort = (): void => {
    settleOnce(() => {
      cleanup();
      options.registry.remove(options.taskId, waiter);
      rejectInContext(
        createProtocolError(
          CONNECTION_CLOSED_ERROR_CODE,
          'Request was cancelled'
        )
      );
    });
  };

  waiter = (updated: TTask): void => {
    settleOnce(() => {
      cleanup();
      if (updated.ownerKey !== options.ownerKey) {
        resolveInContext(undefined);
        return;
      }
      resolveInContext(updated);
    });
  };

  if (options.signal?.aborted) {
    onAbort();
    return promise;
  }

  options.registry.add(options.taskId, waiter);

  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  if (deadlineMs !== null) {
    const timeoutMs = Math.max(0, deadlineMs - Date.now());
    deadlineTimeout = createUnrefTimeout(timeoutMs, { timeout: true });
    void deadlineTimeout.promise
      .then(() => {
        settleOnce(() => {
          cleanup();
          options.registry.remove(options.taskId, waiter);
          options.removeTask(options.taskId);
          rejectInContext(
            createProtocolError(
              ProtocolErrorCode.InvalidParams,
              'Task expired',
              {
                taskId: options.taskId,
              }
            )
          );
        });
      })
      .catch(rejectInContext);
  }

  return promise;
}

export const taskManager = new TaskManager();
