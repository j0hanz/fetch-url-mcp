import { Worker } from 'node:worker_threads';

import { config } from '../config/index.js';
import type {
  MarkdownTransformResult,
  TransformOptions,
} from '../config/types/content.js';

import { getErrorMessage } from '../utils/error-utils.js';
import { isRecord } from '../utils/guards.js';

import { logWarn } from './logger.js';

interface WorkerTransformRequest {
  id: number;
  html: string;
  url: string;
  options: TransformOptions;
}

type WorkerTransformResponse =
  | {
      id: number;
      ok: true;
      result: MarkdownTransformResult;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

interface TransformTask {
  id: number;
  request: WorkerTransformRequest;
  resolve: (result: MarkdownTransformResult) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
  status: 'queued' | 'running';
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  current: TransformTask | undefined;
}

class TransformWorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: TransformTask[] = [];
  private nextId = 1;
  private destroyed = false;

  constructor(
    private readonly workerUrl: URL,
    size: number
  ) {
    for (let i = 0; i < size; i += 1) {
      this.slots.push(this.spawnWorker());
    }
  }

  run(
    request: Omit<WorkerTransformRequest, 'id'>,
    signal?: AbortSignal
  ): Promise<MarkdownTransformResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('Worker pool is shut down'));
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const id = this.nextId;
      this.nextId += 1;

      const task: TransformTask = {
        id,
        request: { ...request, id },
        resolve,
        reject,
        signal,
        abortHandler: undefined,
        status: 'queued',
      };

      if (signal) {
        const onAbort = (): void => {
          if (task.status === 'queued') {
            this.removeQueuedTask(task);
            task.reject(new Error('Aborted'));
            return;
          }
          this.abortRunningTask(task);
        };
        task.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(task);
      this.dispatch();
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    const pending = this.queue.splice(0);
    for (const task of pending) {
      this.cleanupTask(task);
      task.reject(new Error('Worker pool shutting down'));
    }

    for (const slot of this.slots) {
      if (slot.current) {
        const task = slot.current;
        slot.current = undefined;
        slot.busy = false;
        this.cleanupTask(task);
        task.reject(new Error('Worker pool shutting down'));
      }
    }

    await Promise.allSettled(this.slots.map((slot) => slot.worker.terminate()));
    this.slots = [];
  }

  private dispatch(): void {
    if (this.destroyed) return;

    const idle = this.slots.find((slot) => !slot.busy);
    if (!idle) return;

    const task = this.queue.shift();
    if (!task) return;

    task.status = 'running';
    idle.busy = true;
    idle.current = task;

    try {
      idle.worker.postMessage(task.request);
    } catch (error) {
      this.failTask(idle, error);
    }
  }

  private attachWorker(slot: WorkerSlot): void {
    slot.worker.on('message', (message: unknown) => {
      this.handleMessage(slot, message);
    });
    slot.worker.on('error', (error) => {
      this.handleWorkerFailure(slot, error);
    });
    slot.worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerFailure(
          slot,
          new Error(`Worker exited with code ${code}`)
        );
      }
    });
  }

  private spawnWorker(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(this.workerUrl),
      busy: false,
      current: undefined,
    };
    this.attachWorker(slot);
    return slot;
  }

  private handleMessage(slot: WorkerSlot, message: unknown): void {
    const task = slot.current;
    if (!task) return;

    if (!isWorkerResponse(message) || message.id !== task.id) {
      this.handleWorkerFailure(slot, new Error('Unexpected worker response'));
      return;
    }

    slot.current = undefined;
    slot.busy = false;
    this.cleanupTask(task);

    if (message.ok) {
      task.resolve(message.result);
    } else {
      task.reject(new Error(message.error));
    }

    this.dispatch();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: unknown): void {
    const task = slot.current;
    if (task) {
      slot.current = undefined;
      slot.busy = false;
      this.cleanupTask(task);
      task.reject(
        error instanceof Error ? error : new Error(getErrorMessage(error))
      );
    }

    logWarn('Worker thread failure', {
      error: getErrorMessage(error),
    });

    this.replaceWorker(slot);
    this.dispatch();
  }

  private replaceWorker(slot: WorkerSlot): void {
    try {
      void slot.worker.terminate();
    } catch {
      // Best-effort cleanup.
    }
    slot.worker = new Worker(this.workerUrl);
    slot.busy = false;
    slot.current = undefined;
    this.attachWorker(slot);
  }

  private failTask(slot: WorkerSlot, error: unknown): void {
    const task = slot.current;
    if (!task) return;
    slot.current = undefined;
    slot.busy = false;
    this.cleanupTask(task);
    task.reject(error instanceof Error ? error : new Error(String(error)));
    this.dispatch();
  }

  private abortRunningTask(task: TransformTask): void {
    const slot = this.slots.find((s) => s.current?.id === task.id);
    if (!slot) return;
    this.handleWorkerFailure(slot, new Error('Aborted'));
  }

  private removeQueuedTask(task: TransformTask): void {
    const index = this.queue.findIndex((queued) => queued.id === task.id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.cleanupTask(task);
  }

  private cleanupTask(task: TransformTask): void {
    if (task.signal && task.abortHandler) {
      task.signal.removeEventListener('abort', task.abortHandler);
    }
  }
}

function isWorkerResponse(value: unknown): value is WorkerTransformResponse {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'number') return false;
  if (value.ok === true) {
    return 'result' in value;
  }
  if (value.ok === false) {
    return typeof value.error === 'string';
  }
  return false;
}

let pool: TransformWorkerPool | null = null;

function getPool(): TransformWorkerPool {
  if (pool) return pool;
  pool = new TransformWorkerPool(
    new URL('../workers/content-transform.worker.js', import.meta.url),
    config.workers.poolSize
  );
  return pool;
}

export async function transformInWorker(
  request: Omit<WorkerTransformRequest, 'id'>,
  signal?: AbortSignal
): Promise<MarkdownTransformResult> {
  return getPool().run(request, signal);
}

export async function destroyTransformWorkers(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.destroy();
}
