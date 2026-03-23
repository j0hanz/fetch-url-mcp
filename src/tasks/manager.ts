import { randomUUID } from 'node:crypto';
import { createHmac, randomBytes } from 'node:crypto';
import { setInterval } from 'node:timers';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import { config, logWarn } from '../lib/core.js';
import type { ToolHandlerExtra } from '../lib/progress.js';
import { timingSafeEqualUtf8 } from '../lib/utils.js';

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

function isTerminalStatus(status: TaskStatus): boolean {
  return status !== 'working';
}

function resolveNextTaskStatus(
  task: TaskState,
  updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
): TaskStatus {
  const nextStatus = updates.status;
  if (!nextStatus || nextStatus === task.status) return task.status;

  if (!TASK_STATUS_VALUES.has(nextStatus)) {
    throw new McpError(
      ErrorCode.InternalError,
      `Invalid task status '${nextStatus}'`
    );
  }

  if (isTerminalStatus(task.status)) {
    throw new McpError(
      ErrorCode.InternalError,
      `Invalid task status transition: '${task.status}' -> '${nextStatus}'`
    );
  }

  return nextStatus;
}

function normalizeTaskTtl(ttl: number | undefined): number {
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(Math.trunc(Number(ttl)), MAX_TTL_MS));
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
      if (this.tasks.size === 0) this.stopCleanupLoop();
    }, CLEANUP_INTERVAL_MS).unref();
  }

  private stopCleanupLoop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private removeExpiredTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (now - task._createdAtMs > task.ttl) {
        this.removeTask(task.taskId);
      }
    }
  }

  private removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
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
    this.applyTaskUpdate(task, { status: 'cancelled', statusMessage });
    this.waiters.notify(task);
    this.releaseTaskCapacity(task);
  }

  private releaseTaskCapacity(task: InternalTaskState | TaskState): void {
    const internal = task as Partial<InternalTaskState>;
    if (!internal._capacityCounted) return;
    internal._capacityCounted = false;

    const nextCount = (this.ownerCounts.get(task.ownerKey) ?? 0) - 1;
    if (nextCount > 0) {
      this.ownerCounts.set(task.ownerKey, nextCount);
    } else {
      this.ownerCounts.delete(task.ownerKey);
    }

    if (this.activeTaskCount > 0) this.activeTaskCount--;
  }

  private assertTaskCapacity(ownerKey: string): void {
    const { maxPerOwner, maxTotal } = config.tasks;

    if (this.activeTaskCount >= maxTotal) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Task capacity reached (${maxTotal} total tasks)`
      );
    }

    if ((this.ownerCounts.get(ownerKey) ?? 0) >= maxPerOwner) {
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
    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1);
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

    if (Date.now() - task._createdAtMs > task.ttl) {
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

    this.waiters.notify(task);
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
    return task;
  }

  cancelTasksByOwner(
    ownerKey: string,
    statusMessage = 'The task was cancelled because its owner is no longer active.'
  ): TaskState[] {
    if (!ownerKey) return [];

    const cancelled: TaskState[] = [];
    for (const task of this.tasks.values()) {
      if (task.ownerKey === ownerKey && !isTerminalStatus(task.status)) {
        this.cancelActiveTask(task, statusMessage);
        cancelled.push(task);
      }
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

      if (now - task._createdAtMs > task.ttl) {
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

    return anchorFound ? page : [];
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
    if (!decoded) throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
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
      ...(signal && { signal }),
      lookupTask: (id, owner) => this.lookupActiveTask(id, owner),
      removeTask: (id) => {
        this.removeTask(id);
      },
      registry: this.waiters,
      isTerminalStatus,
    });
  }

  shrinkTtlAfterDelivery(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || !isTerminalStatus(task.status)) return;

    const newTtl = Date.now() - task._createdAtMs + RESULT_DELIVERY_GRACE_MS;
    if (newTtl < task.ttl) {
      task.ttl = newTtl;
      task.lastUpdatedAt = new Date().toISOString();
    }
  }
}

export const taskManager = new TaskManager();

const MAX_CURSOR_LENGTH = 256;
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

export function decodeTaskCursor(
  cursor: string
): { anchorTaskId: string } | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) return null;

  const [payload, signature, ...rest] = cursor.split('.');
  if (!payload || !signature || rest.length > 0) return null;
  if (!timingSafeEqualUtf8(signPayload(payload), signature)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { anchorTaskId?: unknown };
    if (
      typeof decoded.anchorTaskId !== 'string' ||
      decoded.anchorTaskId.length === 0 ||
      decoded.anchorTaskId.length > 128
    ) {
      return null;
    }

    return { anchorTaskId: decoded.anchorTaskId };
  } catch {
    return null;
  }
}

export type TaskCapableToolSupport = 'optional' | 'forbidden';

export interface TaskCapableToolDescriptor<TArgs = unknown> {
  name: string;
  parseArguments: (args: unknown) => TArgs;
  execute: (args: TArgs, extra?: ToolHandlerExtra) => Promise<ServerResult>;
  getCompletionStatusMessage?: (result: ServerResult) => string | undefined;
  taskSupport?: TaskCapableToolSupport;
}

const taskCapableTools = new Map<string, TaskCapableToolDescriptor>();

export function registerTaskCapableTool<TArgs>(
  descriptor: TaskCapableToolDescriptor<TArgs>
): void {
  taskCapableTools.set(descriptor.name, {
    ...descriptor,
    taskSupport: descriptor.taskSupport ?? 'optional',
  } as TaskCapableToolDescriptor);
}

export function unregisterTaskCapableTool(name: string): void {
  taskCapableTools.delete(name);
}

export function getTaskCapableTool(
  name: string
): TaskCapableToolDescriptor | undefined {
  return taskCapableTools.get(name);
}

export function getTaskCapableToolSupport(
  name: string
): TaskCapableToolSupport | undefined {
  return taskCapableTools.get(name)?.taskSupport;
}

export function hasTaskCapableTool(name: string): boolean {
  return taskCapableTools.has(name);
}

export function hasRegisteredTaskCapableTools(): boolean {
  return taskCapableTools.size > 0;
}

export function setTaskCapableToolSupport(
  name: string,
  support: TaskCapableToolSupport
): void {
  const descriptor = taskCapableTools.get(name);
  if (!descriptor) return;
  descriptor.taskSupport = support;
}
