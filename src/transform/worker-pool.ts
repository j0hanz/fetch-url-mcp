import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { availableParallelism } from 'node:os';
import process from 'node:process';
import { isSharedArrayBuffer } from 'node:util/types';
import {
  isMainThread,
  isMarkedAsUntransferable,
  type Transferable as NodeTransferable,
  parentPort,
  Worker,
} from 'node:worker_threads';

import { z } from 'zod';

import { config, logWarn } from '../lib/core.js';
import {
  type CancellableTimeout,
  createAbortError,
  createUnrefTimeout,
  FetchError,
  getErrorMessage,
} from '../lib/utils.js';
import { formatZodError } from '../lib/zod.js';

import { extractedMetadataSchema } from '../schemas.js';
import { createTransformMessageHandler } from './shared.js';
import { transformHtmlToMarkdownInProcess } from './transform.js';
import type {
  MarkdownTransformResult,
  TransformWorkerOutgoingMessage,
  TransformWorkerTransformMessage,
} from './types.js';

// Worker message validation

const workerResultPayloadSchema = z.strictObject({
  markdown: z.string(),
  title: z.string().optional(),
  metadata: extractedMetadataSchema.optional(),
  truncated: z.boolean(),
});

const workerErrorPayloadSchema = z.strictObject({
  name: z.string(),
  message: z.string(),
  url: z.string(),
  statusCode: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const workerResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('result'),
    id: z.string(),
    result: workerResultPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.string(),
    error: workerErrorPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('cancelled'),
    id: z.string(),
  }),
]);

// Task context (preserves async context across worker callbacks)

interface TaskContext {
  run: (fn: () => void) => void;
  dispose: () => void;
}

function createTaskContext(): TaskContext {
  const runWithStore = AsyncLocalStorage.snapshot();
  const asyncResource = new AsyncResource('fetch-url-mcp.transform.task');
  let disposed = false;

  return {
    run: (fn) => {
      runWithStore(() => {
        asyncResource.runInAsyncScope(fn);
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      asyncResource.emitDestroy();
    },
  };
}

// Task & worker types

interface PendingTask {
  id: string;
  html?: string;
  htmlBuffer?: Uint8Array;
  encoding?: string;
  url: string;
  includeMetadata: boolean;
  inputTruncated?: boolean;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  context: TaskContext;
  resolve: (result: MarkdownTransformResult) => void;
  reject: (error: unknown) => void;
}

interface WorkerDispatchPayload {
  message: TransformWorkerTransformMessage;
  transferList?: NodeTransferable[];
}

function ensureTightBuffer(buffer: Uint8Array): Uint8Array {
  if (
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength
  ) {
    return buffer;
  }

  return Buffer.from(buffer);
}

function getTransferableBuffer(buffer: Uint8Array): ArrayBuffer | null {
  const backingBuffer = buffer.buffer;
  if (isSharedArrayBuffer(backingBuffer)) return null;
  if (!(backingBuffer instanceof ArrayBuffer)) return null;
  return isMarkedAsUntransferable(backingBuffer) ? null : backingBuffer;
}

function buildWorkerDispatchPayload(task: PendingTask): WorkerDispatchPayload {
  const message: TransformWorkerTransformMessage = {
    type: 'transform',
    id: task.id,
    url: task.url,
    includeMetadata: task.includeMetadata,
    ...(task.inputTruncated ? { inputTruncated: true } : {}),
  };

  if (!task.htmlBuffer) {
    message.html = task.html;
    return { message };
  }

  const htmlBuffer = ensureTightBuffer(task.htmlBuffer);
  message.htmlBuffer = htmlBuffer;
  if (task.encoding) message.encoding = task.encoding;

  const transferableBuffer = getTransferableBuffer(htmlBuffer);
  return transferableBuffer
    ? { message, transferList: [transferableBuffer] }
    : { message };
}

interface InflightTask {
  resolve: PendingTask['resolve'];
  reject: PendingTask['reject'];
  timeout: CancellableTimeout<null>;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  workerIndex: number;
  context: TaskContext;
  cancelPending: boolean;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentTaskId: string | null;
  name: string;
}

interface TransformWorkerPool {
  transform(
    html: string,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      inputTruncated?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  close(): Promise<void>;
  getQueueDepth(): number;
  getActiveWorkers(): number;
  getCapacity(): number;
}

// Pool sizing & constants

// Core tuning: ~half of available CPUs as baseline, capped by config limits.
const POOL_MIN_WORKERS = Math.max(
  2,
  Math.min(4, Math.floor(availableParallelism() / 2))
);
const POOL_MAX_WORKERS = config.transform.maxWorkerScale;
const POOL_SCALE_THRESHOLD = 0.5;
const WORKER_NAME_PREFIX = 'fetch-url-mcp-transform';

const DEFAULT_TIMEOUT_MS = config.transform.timeoutMs;
const TRANSFORM_WORKER_PATH = new URL(import.meta.url);

// TaskQueue — array-deque with auto-compaction

class TaskQueue<T extends { id: string }> {
  private items: (T | undefined)[] = [];
  private head = 0;

  get depth(): number {
    const d = this.items.length - this.head;
    return d > 0 ? d : 0;
  }

  enqueue(item: T): void {
    this.items.push(item);
  }

  dequeue(): T | null {
    while (this.head < this.items.length) {
      const item = this.items[this.head];
      this.head += 1;

      if (item) {
        this.compact();
        return item;
      }
    }

    this.compact();
    return null;
  }

  removeById(id: string): T | undefined {
    for (let i = this.head; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item?.id === id) {
        this.items.splice(i, 1);
        this.compact();
        return item;
      }
    }
    return undefined;
  }

  drain(callback: (item: T) => void): void {
    for (let i = this.head; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item) callback(item);
    }
    this.items.length = 0;
    this.head = 0;
  }

  private compact(): void {
    if (this.head === 0) return;

    if (
      this.head >= this.items.length ||
      (this.head > 1024 && this.head > this.items.length / 2)
    ) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
  }
}

// CancelAckTracker — isolates the cancel-acknowledgement protocol

class CancelAckTracker {
  private readonly pending = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      timeout: CancellableTimeout<void>;
    }
  >();

  resolve(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.timeout.cancel();
    entry.resolve();
  }

  wait(id: string, timeoutMs: number): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing.promise;

    let resolve: () => void = () => {};
    const timeout = createUnrefTimeout(timeoutMs, undefined);
    const racePromise = new Promise<void>((finish) => {
      resolve = finish;
    });

    const promise = Promise.race([racePromise, timeout.promise]).finally(() => {
      this.pending.delete(id);
      timeout.cancel();
    });

    this.pending.set(id, { promise, resolve, timeout });
    return promise;
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.timeout.cancel();
      entry.resolve();
    }
    this.pending.clear();
  }
}

// WorkerPool

class WorkerPool implements TransformWorkerPool {
  private static readonly CLOSED_MESSAGE = 'Transform worker pool closed';

  private readonly workers: (WorkerSlot | undefined)[] = [];
  private capacity: number;
  private readonly minCapacity = POOL_MIN_WORKERS;
  private readonly maxCapacity = POOL_MAX_WORKERS;

  private readonly queue = new TaskQueue<PendingTask>();
  private readonly inflight = new Map<string, InflightTask>();
  private readonly cancelAcks = new CancelAckTracker();

  private readonly timeoutMs: number;
  private readonly queueMax: number;
  private closed = false;
  private taskIdSeq = 0;
  private busyCount = 0;

  constructor(size: number, timeoutMs: number) {
    this.capacity =
      size === 0
        ? 0
        : Math.max(this.minCapacity, Math.min(size, this.maxCapacity));
    this.timeoutMs = timeoutMs;
    this.queueMax = this.maxCapacity * 4;
  }

  async transform(
    html: string,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      inputTruncated?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  async transform(
    htmlBuffer: Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      inputTruncated?: boolean;
      encoding?: string;
    }
  ): Promise<MarkdownTransformResult>;
  async transform(
    htmlOrBuffer: string | Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      inputTruncated?: boolean;
      encoding?: string;
    }
  ): Promise<MarkdownTransformResult> {
    this.ensureOpen();
    if (options.signal?.aborted)
      throw createAbortError(url, 'transform:enqueue');

    if (this.queue.depth >= this.queueMax) {
      throw new FetchError('Transform worker queue is full', url, 503, {
        reason: 'queue_full',
        stage: 'transform:enqueue',
      });
    }

    return new Promise<MarkdownTransformResult>((resolve, reject) => {
      const task = this.createPendingTask(
        htmlOrBuffer,
        url,
        options,
        resolve,
        reject
      );
      this.queue.enqueue(task);
      this.drainQueue();
    });
  }

  getQueueDepth(): number {
    return this.queue.depth;
  }

  getActiveWorkers(): number {
    return this.busyCount;
  }

  getCapacity(): number {
    return this.capacity;
  }

  resize(size: number): void {
    const newCapacity = Math.max(
      this.minCapacity,
      Math.min(size, this.maxCapacity)
    );
    if (newCapacity === this.capacity) return;

    this.capacity = newCapacity;
    this.drainQueue();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const terminations = this.workers
      .map((slot) => slot?.worker.terminate().catch(() => undefined))
      .filter((p): p is Promise<number> => p !== undefined);

    this.workers.fill(undefined);
    this.workers.length = 0;
    this.busyCount = 0;
    this.cancelAcks.dispose();

    for (const id of Array.from(this.inflight.keys())) {
      const inflight = this.takeInflight(id);
      if (!inflight) continue;
      this.finalizeTask(inflight.context, () => {
        inflight.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }

    this.queue.drain((task) => {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    });

    await Promise.allSettled(terminations);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error(WorkerPool.CLOSED_MESSAGE);
  }

  private createPendingTask(
    htmlOrBuffer: string | Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      inputTruncated?: boolean;
      encoding?: string;
    },
    resolve: (result: MarkdownTransformResult) => void,
    reject: (error: unknown) => void
  ): PendingTask {
    const id = (this.taskIdSeq++).toString(36);

    // Preserve request context for resolve/reject even when callbacks fire
    // from worker thread events.
    const context = createTaskContext();

    let abortListener: (() => void) | undefined;
    if (options.signal) {
      abortListener = () => {
        this.onAbortSignal(id, url, context, reject);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const task: PendingTask = {
      id,
      url,
      includeMetadata: options.includeMetadata,
      ...(options.inputTruncated ? { inputTruncated: true } : {}),
      signal: options.signal,
      abortListener,
      context,
      resolve,
      reject,
    };

    if (typeof htmlOrBuffer === 'string') {
      task.html = htmlOrBuffer;
    } else {
      task.htmlBuffer = htmlOrBuffer;
      if (options.encoding) {
        task.encoding = options.encoding;
      }
    }

    return task;
  }

  private onAbortSignal(
    id: string,
    url: string,
    context: TaskContext,
    reject: (error: unknown) => void
  ): void {
    if (this.closed) {
      this.finalizeTask(context, () => {
        reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
      return;
    }

    const inflight = this.inflight.get(id);
    if (inflight) {
      void this.abortInflight(id, url, inflight.workerIndex);
      return;
    }

    const queuedTask = this.queue.removeById(id);
    if (queuedTask) {
      this.clearAbortListener(queuedTask.signal, queuedTask.abortListener);
      this.finalizeTask(queuedTask.context, () => {
        queuedTask.reject(createAbortError(url, 'transform:queued-abort'));
      });
    }
  }

  private async abortInflight(
    id: string,
    url: string,
    workerIndex: number
  ): Promise<void> {
    const slot = this.workers[workerIndex];
    const inflight = this.inflight.get(id);
    if (inflight) {
      inflight.cancelPending = true;
    }
    if (slot) {
      try {
        slot.worker.postMessage({ type: 'cancel', id });
      } catch {
        // Worker may be unavailable; failure is acceptable during abort
      }
    }

    await this.cancelAcks.wait(id, config.transform.cancelAckTimeoutMs);

    const taken = this.failTask(
      id,
      createAbortError(url, 'transform:signal-abort')
    );
    if (taken && slot) this.restartWorker(workerIndex, slot);
  }

  private clearAbortListener(
    signal: AbortSignal | undefined,
    listener: (() => void) | undefined
  ): void {
    if (!signal || !listener) return;
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      // Defensive: removeEventListener should not throw, but handle edge cases
    }
  }

  private spawnWorker(workerIndex: number): WorkerSlot {
    const name = `${WORKER_NAME_PREFIX}-${workerIndex + 1}`;
    const resourceLimits = config.transform.workerResourceLimits;
    const worker = new Worker(TRANSFORM_WORKER_PATH, {
      name,
      ...(resourceLimits ? { resourceLimits } : {}),
    });

    worker.unref();

    worker.on('message', (raw: unknown) => {
      this.onWorkerMessage(workerIndex, raw);
    });
    worker.on('error', (error: unknown) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker error: ${getErrorMessage(error)}`
      );
    });
    worker.on('messageerror', (error: unknown) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker error: ${getErrorMessage(error)}`
      );
    });
    worker.on('exit', (code: number | null) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker exited (code ${code ?? 'unknown'})`
      );
    });

    return { worker, busy: false, currentTaskId: null, name };
  }

  private onWorkerBroken(workerIndex: number, message: string): void {
    if (this.closed) return;

    const slot = this.workers[workerIndex];
    if (!slot) return;

    logWarn('Transform worker unavailable; restarting', {
      reason: message,
      workerIndex,
      workerName: slot.name,
      threadId: slot.worker.threadId,
    });

    if (slot.busy && slot.currentTaskId) {
      try {
        this.failTask(
          slot.currentTaskId,
          new FetchError(message, '', 503, { reason: 'worker_exit' })
        );
      } catch {
        this.markIdle(workerIndex);
      }
    }

    this.restartWorker(workerIndex, slot);
  }

  private restartWorker(workerIndex: number, slot?: WorkerSlot): void {
    if (this.closed) return;

    const target = slot ?? this.workers[workerIndex];
    if (target) {
      target.worker.terminate().catch(() => undefined);
    }

    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    const parsed = workerResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker sent invalid message: ${formatZodError(parsed.error)}`
      );
      return;
    }

    const message: TransformWorkerOutgoingMessage = parsed.data;

    if (message.type === 'cancelled') {
      this.cancelAcks.resolve(message.id);
      return;
    }

    const inflightPeek = this.inflight.get(message.id);
    if (inflightPeek?.cancelPending) {
      this.cancelAcks.resolve(message.id);
      return;
    }

    const inflight = this.takeInflight(message.id);
    if (!inflight) return;

    this.markIdle(workerIndex);

    if (message.type === 'result') {
      this.finalizeTask(inflight.context, () => {
        inflight.resolve({
          markdown: message.result.markdown,
          truncated: message.result.truncated,
          title: message.result.title,
          ...(message.result.metadata
            ? { metadata: message.result.metadata }
            : {}),
        });
      });
    } else {
      const err = message.error;
      if (err.name === 'FetchError') {
        this.finalizeTask(inflight.context, () => {
          inflight.reject(
            new FetchError(
              err.message,
              err.url,
              err.statusCode,
              err.details ?? {}
            )
          );
        });
      } else {
        this.finalizeTask(inflight.context, () => {
          inflight.reject(new Error(err.message));
        });
      }
    }

    this.drainQueue();
  }

  private takeInflight(id: string): InflightTask | null {
    const inflight = this.inflight.get(id);
    if (!inflight) return null;

    inflight.timeout.cancel();
    this.clearAbortListener(inflight.signal, inflight.abortListener);
    this.inflight.delete(id);

    return inflight;
  }

  private markIdle(workerIndex: number): void {
    const slot = this.workers[workerIndex];
    if (!slot) return;
    if (slot.busy) {
      slot.busy = false;
      this.busyCount -= 1;
    }
    slot.currentTaskId = null;
  }

  private failTask(id: string, error: unknown): boolean {
    const inflight = this.takeInflight(id);
    if (!inflight) return false;

    this.finalizeTask(inflight.context, () => {
      inflight.reject(error);
    });
    this.markIdle(inflight.workerIndex);
    return true;
  }

  private maybeScaleUp(): void {
    if (
      this.getQueueDepth() > this.capacity * POOL_SCALE_THRESHOLD &&
      this.capacity < this.maxCapacity
    ) {
      this.capacity += 1;
    }
  }

  private drainQueue(): void {
    if (this.closed || this.queue.depth === 0) return;

    this.maybeScaleUp();

    for (let i = 0; i < this.workers.length; i += 1) {
      const slot = this.workers[i];
      if (slot && !slot.busy) {
        this.dispatchFromQueue(i, slot);
        if (this.queue.depth === 0) return;
      }
    }

    if (this.workers.length < this.capacity && this.queue.depth > 0) {
      const workerIndex = this.workers.length;
      const slot = this.spawnWorker(workerIndex);
      this.workers.push(slot);
      this.dispatchFromQueue(workerIndex, slot);

      if (this.workers.length < this.capacity && this.queue.depth > 0) {
        setImmediate(() => {
          this.drainQueue();
        });
      }
    }
  }

  private dispatchFromQueue(workerIndex: number, slot: WorkerSlot): void {
    const task = this.queue.dequeue();
    if (!task) return;

    if (this.closed) {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
      return;
    }

    if (task.signal?.aborted) {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(createAbortError(task.url, 'transform:dispatch'));
      });
      return;
    }

    slot.busy = true;
    slot.currentTaskId = task.id;
    this.busyCount += 1;

    const timeout = this.registerInflight(task, workerIndex, slot);
    this.sendToWorker(task, slot, workerIndex, timeout);
  }

  private registerInflight(
    task: PendingTask,
    workerIndex: number,
    slot: WorkerSlot
  ): CancellableTimeout<null> {
    const timeout = createUnrefTimeout(this.timeoutMs, null);
    void timeout.promise
      .then(() => {
        try {
          slot.worker.postMessage({ type: 'cancel', id: task.id });
        } catch {
          // Worker may be unavailable; proceed with timeout handling
        }

        const inflight = this.takeInflight(task.id);
        if (!inflight) return;

        this.finalizeTask(inflight.context, () => {
          inflight.reject(
            new FetchError('Request timeout', task.url, 504, {
              reason: 'timeout',
              stage: 'transform:worker-timeout',
            })
          );
        });

        this.restartWorker(workerIndex, slot);
      })
      .catch((error: unknown) => {
        this.failTask(task.id, error);
      });

    this.inflight.set(task.id, {
      resolve: task.resolve,
      reject: task.reject,
      timeout,
      signal: task.signal,
      abortListener: task.abortListener,
      workerIndex,
      context: task.context,
      cancelPending: false,
    });

    return timeout;
  }

  private sendToWorker(
    task: PendingTask,
    slot: WorkerSlot,
    workerIndex: number,
    timeout: CancellableTimeout<null>
  ): void {
    try {
      const { message, transferList } = buildWorkerDispatchPayload(task);
      slot.worker.postMessage(message, transferList);
    } catch (error: unknown) {
      timeout.cancel();
      this.clearAbortListener(task.signal, task.abortListener);
      this.inflight.delete(task.id);
      this.markIdle(workerIndex);

      this.finalizeTask(task.context, () => {
        task.reject(
          error instanceof Error
            ? error
            : new Error('Failed to dispatch transform worker message')
        );
      });
      this.restartWorker(workerIndex, slot);
    }
  }

  private finalizeTask(context: TaskContext, fn: () => void): void {
    try {
      context.run(fn);
    } finally {
      context.dispose();
    }
  }
}

// Pool singleton management

let workerPool: WorkerPool | null = null;

export function getOrCreateWorkerPool(): WorkerPool {
  const size = config.transform.maxWorkerScale === 0 ? 0 : POOL_MIN_WORKERS;
  workerPool ??= new WorkerPool(size, DEFAULT_TIMEOUT_MS);
  return workerPool;
}

export function getWorkerPoolStats(): {
  queueDepth: number;
  activeWorkers: number;
  capacity: number;
} | null {
  if (!workerPool) return null;
  return {
    queueDepth: workerPool.getQueueDepth(),
    activeWorkers: workerPool.getActiveWorkers(),
    capacity: workerPool.getCapacity(),
  };
}

export async function shutdownWorkerPool(): Promise<void> {
  if (!workerPool) return;
  await workerPool.close();
  workerPool = null;
}

// Worker thread message handling

function bootstrapWorkerThread(): void {
  if (!isMainThread && parentPort) {
    const port = parentPort;
    const onMessage = createTransformMessageHandler({
      sendMessage: (message) => {
        port.postMessage(message);
      },
      runTransform: transformHtmlToMarkdownInProcess,
    });
    port.on('message', onMessage);
  } else if (process.send) {
    const send = process.send.bind(process);
    const onMessage = createTransformMessageHandler({
      sendMessage: (message) => {
        send(message);
      },
      runTransform: transformHtmlToMarkdownInProcess,
    });
    process.on('message', onMessage);
  }
}

bootstrapWorkerThread();
