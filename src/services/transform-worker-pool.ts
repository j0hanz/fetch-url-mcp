import os from 'node:os';
import { isMainThread, Worker } from 'node:worker_threads';

import { config } from '../config/index.js';
import type {
  JsonlTransformResult,
  MarkdownTransformResult,
  TransformOptions,
} from '../config/types/content.js';

import { getErrorMessage } from '../utils/error-utils.js';

import { logWarn } from './logger.js';

type TransformMode = 'jsonl' | 'markdown' | 'markdown-blocks';

export interface TransformJob {
  mode: TransformMode;
  html: string;
  url: string;
  options: TransformOptions & {
    includeContentBlocks?: boolean;
  };
}

type TransformResult = JsonlTransformResult | MarkdownTransformResult;

type TransformResponse =
  | { id: number; ok: true; result: TransformResult }
  | { id: number; ok: false; error: string };

interface QueuedJob extends TransformJob {
  id: number;
}

interface PendingJob {
  resolve: (result: TransformResult) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
  currentJobId: number | undefined;
}

const MAX_POOL_SIZE = 4;

function resolvePoolSize(): number {
  const available = os.availableParallelism();
  return Math.max(1, Math.min(available - 1, MAX_POOL_SIZE));
}

let pool: TransformWorkerPool | null = null;
let poolDisabled = false;

function shouldUseWorkers(): boolean {
  return isMainThread && config.runtime.httpMode && !poolDisabled;
}

function getWorkerUrl(): URL {
  return new URL('../workers/transform-worker.js', import.meta.url);
}

export async function runTransformInWorker(
  job: TransformJob
): Promise<TransformResult | null> {
  if (!shouldUseWorkers()) return null;
  if (!pool) {
    try {
      pool = new TransformWorkerPool(getWorkerUrl(), resolvePoolSize());
    } catch (error) {
      poolDisabled = true;
      logWarn('Failed to initialize transform worker pool', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  try {
    return await pool.run(job);
  } catch (error) {
    poolDisabled = true;
    pool.destroy();
    pool = null;
    logWarn('Transform worker failed; falling back to main thread', {
      error: getErrorMessage(error),
    });
    return null;
  }
}

export function destroyTransformWorkers(): void {
  pool?.destroy();
  pool = null;
}

class TransformWorkerPool {
  private readonly workers: WorkerState[] = [];
  private readonly queue: QueuedJob[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private nextId = 1;
  private destroyed = false;

  constructor(
    private readonly workerUrl: URL,
    private readonly size: number
  ) {
    for (let i = 0; i < size; i += 1) {
      this.workers.push(this.createWorker());
    }
  }

  run(job: TransformJob): Promise<TransformResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('Transform worker pool is closed'));
    }

    const id = this.nextId++;
    const queuedJob = { ...job, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.queue.push(queuedJob);
      this.schedule();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const workerState of this.workers) {
      void workerState.worker.terminate();
    }

    for (const [id, pending] of this.pending.entries()) {
      pending.reject(new Error('Transform worker pool shut down'));
      this.pending.delete(id);
    }

    this.queue.length = 0;
  }

  private createWorker(): WorkerState {
    const worker = new Worker(this.workerUrl);
    worker.unref();

    const state: WorkerState = { worker, busy: false, currentJobId: undefined };
    worker.on('message', (message: TransformResponse) => {
      this.handleMessage(state, message);
    });
    worker.on('error', (error: Error) => {
      this.handleWorkerError(state, error);
    });
    worker.on('exit', (code: number) => {
      this.handleWorkerExit(state, code);
    });
    return state;
  }

  private handleMessage(state: WorkerState, message: TransformResponse): void {
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    }

    state.busy = false;
    state.currentJobId = undefined;
    this.schedule();
  }

  private handleWorkerError(state: WorkerState, error: Error): void {
    this.failCurrentJob(state, error);
    this.replaceWorker(state);
  }

  private handleWorkerExit(state: WorkerState, code: number): void {
    if (code !== 0) {
      this.failCurrentJob(
        state,
        new Error(`Transform worker exited with code ${code}`)
      );
    }
    this.replaceWorker(state);
  }

  private failCurrentJob(state: WorkerState, error: Error): void {
    if (!state.currentJobId) return;
    const pending = this.pending.get(state.currentJobId);
    if (pending) {
      pending.reject(error);
      this.pending.delete(state.currentJobId);
    }
    state.currentJobId = undefined;
    state.busy = false;
  }

  private replaceWorker(state: WorkerState): void {
    if (this.destroyed) return;
    const index = this.workers.indexOf(state);
    if (index === -1) return;
    this.workers[index] = this.createWorker();
    this.schedule();
  }

  private schedule(): void {
    if (this.destroyed) return;
    for (const workerState of this.workers) {
      if (this.queue.length === 0) return;
      if (workerState.busy) continue;

      const job = this.queue.shift();
      if (!job) return;

      workerState.busy = true;
      workerState.currentJobId = job.id;
      workerState.worker.postMessage(job);
    }
  }
}
