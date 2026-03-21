import { AsyncLocalStorage } from 'node:async_hooks';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { toError } from '../lib/utils.js';
import { type CancellableTimeout, createUnrefTimeout } from '../lib/utils.js';

interface WaitableTask {
  taskId: string;
  ownerKey: string;
  status: string;
  ttl: number;
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

  const deadlineMs = task._createdAtMs + task.ttl;

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
    if (settled) return;
    settled = true;
    fn();
  };

  const onAbort = (): void => {
    settleOnce(() => {
      cleanup();
      options.registry.remove(options.taskId, waiter);
      rejectInContext(
        new McpError(ErrorCode.ConnectionClosed, 'Request was cancelled')
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
    return;
  }

  options.registry.add(options.taskId, waiter);

  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const timeoutMs = Math.max(0, deadlineMs - Date.now());

  deadlineTimeout = createUnrefTimeout(timeoutMs, { timeout: true });
  void deadlineTimeout.promise
    .then(() => {
      settleOnce(() => {
        cleanup();
        options.registry.remove(options.taskId, waiter);
        options.removeTask(options.taskId);
        rejectInContext(
          new McpError(ErrorCode.InvalidParams, 'Task expired', {
            taskId: options.taskId,
          })
        );
      });
    })
    .catch(rejectInContext);

  return promise;
}
