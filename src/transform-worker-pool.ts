import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSharedArrayBuffer } from 'node:util/types';
import {
  type Transferable as NodeTransferable,
  Worker,
} from 'node:worker_threads';

import { config } from './config.js';
import { FetchError, getErrorMessage } from './errors.js';
import { logWarn } from './observability.js';
import { type CancellableTimeout, createUnrefTimeout } from './timer-utils.js';
import type {
  MarkdownTransformResult,
  TransformWorkerCancelMessage,
  TransformWorkerErrorMessage,
  TransformWorkerOutgoingMessage,
  TransformWorkerResultMessage,
  TransformWorkerTransformMessage,
} from './transform-types.js';
import { isObject } from './type-guards.js';

// ---------------------------------------------------------------------------
// Abort helper (inlined to avoid circular dependency with transform.ts)
// ---------------------------------------------------------------------------

function createAbortError(url: string, stage: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}

// ---------------------------------------------------------------------------
// Worker message validation
// ---------------------------------------------------------------------------

function isWorkerResultPayload(
  value: unknown
): value is TransformWorkerResultMessage['result'] {
  if (!isObject(value)) return false;
  const { markdown, metadata, title, truncated } = value;
  const isMetadataObject = metadata === undefined || isObject(metadata);

  if (!isMetadataObject) return false;

  if (metadata && !isExtractedMetadataPayload(metadata)) {
    return false;
  }

  return (
    typeof markdown === 'string' &&
    typeof truncated === 'boolean' &&
    (title === undefined || typeof title === 'string')
  );
}

function isExtractedMetadataPayload(value: unknown): boolean {
  if (!isObject(value)) return false;

  const {
    author,
    description,
    favicon,
    image,
    modifiedAt,
    publishedAt,
    title,
  } = value;

  return (
    (title === undefined || typeof title === 'string') &&
    (description === undefined || typeof description === 'string') &&
    (author === undefined || typeof author === 'string') &&
    (image === undefined || typeof image === 'string') &&
    (favicon === undefined || typeof favicon === 'string') &&
    (publishedAt === undefined || typeof publishedAt === 'string') &&
    (modifiedAt === undefined || typeof modifiedAt === 'string')
  );
}

function isWorkerErrorPayload(
  value: unknown
): value is TransformWorkerErrorMessage['error'] {
  if (!isObject(value)) return false;
  const { details, message, name, statusCode, url } = value;
  return (
    typeof name === 'string' &&
    typeof message === 'string' &&
    typeof url === 'string' &&
    (statusCode === undefined || typeof statusCode === 'number') &&
    (details === undefined || isObject(details))
  );
}

function isWorkerResponse(raw: unknown): raw is TransformWorkerOutgoingMessage {
  if (!isObject(raw)) return false;
  if (typeof raw['id'] !== 'string') return false;

  if (raw['type'] === 'result') {
    return isWorkerResultPayload(raw['result']);
  }

  if (raw['type'] === 'error') {
    return isWorkerErrorPayload(raw['error']);
  }

  if (raw['type'] === 'cancelled') {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Task context (preserves async context across worker callbacks)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Task & worker types
// ---------------------------------------------------------------------------

interface PendingTask {
  id: string;
  html?: string;
  htmlBuffer?: Uint8Array;
  encoding?: string;
  url: string;
  includeMetadata: boolean;
  skipNoiseRemoval?: boolean;
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

function buildWorkerDispatchPayload(
  task: PendingTask,
  supportsTransferList: boolean
): WorkerDispatchPayload {
  const message: TransformWorkerTransformMessage = {
    type: 'transform',
    id: task.id,
    url: task.url,
    includeMetadata: task.includeMetadata,
    ...(task.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    ...(task.inputTruncated ? { inputTruncated: true } : {}),
  };

  if (!task.htmlBuffer) {
    message.html = task.html;
    return { message };
  }

  const htmlBuffer = ensureTightBuffer(task.htmlBuffer);
  if (!supportsTransferList) {
    message.htmlBuffer = htmlBuffer;
    if (task.encoding) message.encoding = task.encoding;
    return { message };
  }

  const transferableHtmlBuffer = Uint8Array.from(htmlBuffer);
  message.htmlBuffer = transferableHtmlBuffer;
  if (task.encoding) message.encoding = task.encoding;

  const backingBuffer = transferableHtmlBuffer.buffer;
  if (isSharedArrayBuffer(backingBuffer)) return { message };
  return { message, transferList: [backingBuffer] };
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

type TransformWorkerMessage =
  | TransformWorkerTransformMessage
  | TransformWorkerCancelMessage;

interface WorkerHost {
  kind: 'thread' | 'process';
  supportsTransferList: boolean;
  threadId?: number;
  pid?: number;
  postMessage: (
    message: TransformWorkerMessage,
    transferList?: NodeTransferable[]
  ) => void;
  terminate: () => Promise<void>;
  unref: () => void;
  onMessage: (handler: (raw: unknown) => void) => void;
  onError: (handler: (error: unknown) => void) => void;
  onExit: (
    handler: (code: number | null, signal: NodeJS.Signals | null) => void
  ) => void;
}

type WorkerSpawner = (workerIndex: number, name: string) => WorkerHost;

interface WorkerSlot {
  host: WorkerHost;
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
      skipNoiseRemoval?: boolean;
      inputTruncated?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  close(): Promise<void>;
  getQueueDepth(): number;
  getActiveWorkers(): number;
  getCapacity(): number;
}

// ---------------------------------------------------------------------------
// Pool sizing & constants
// ---------------------------------------------------------------------------

/**
 * Worker Pool Sizing Configuration
 *
 * Default: min(4, floor(availableParallelism() / 2)), constrained to [2, N]
 *
 * Tuning Guidance:
 * - **Default behavior**: Appropriate for most deployments. Uses half of available
 *   CPU threads (capped at 4) to balance throughput with system resource availability.
 *
 * - **CPU-limited containers**: If running in a container with strict CPU limits
 *   (e.g., Docker with --cpus=2), the default may over-subscribe. Consider setting
 *   maxWorkerScale to match the container's CPU limit.
 *
 * - **High-concurrency workloads**: For dedicated servers handling many concurrent
 *   fetch requests, increasing maxWorkerScale to (availableParallelism() + 2) may
 *   improve throughput by overlapping I/O wait with computation.
 *
 * - **Memory-constrained environments**: Each worker allocates ~50-100MB for DOM
 *   parsing. If memory is limited, reduce maxWorkerScale to (availableParallelism() / 2)
 *   or lower to prevent OOM errors.
 *
 * - **Shared hosting**: On shared systems where CPU is contested, reducing the pool
 *   size prevents starving other processes. Consider maxWorkerScale = 2 or using
 *   process-based workers (TRANSFORM_WORKER_MODE=process) for better isolation.
 *
 * Configuration:
 * - TRANSFORM_MAX_WORKER_SCALE env var (default: availableParallelism())
 * - TRANSFORM_WORKER_MODE env var: 'threads' (default) or 'process'
 *
 * See config.ts for full worker configuration options.
 */
const POOL_MIN_WORKERS = Math.max(
  2,
  Math.min(4, Math.floor(availableParallelism() / 2))
);
const POOL_MAX_WORKERS = config.transform.maxWorkerScale;
const POOL_SCALE_THRESHOLD = 0.5;
const WORKER_NAME_PREFIX = 'fetch-url-mcp-transform';

const DEFAULT_TIMEOUT_MS = config.transform.timeoutMs;
const TRANSFORM_CHILD_PATH = fileURLToPath(
  new URL('./workers/transform-child.js', import.meta.url)
);

// ---------------------------------------------------------------------------
// Worker host spawners
// ---------------------------------------------------------------------------

function createThreadWorkerHost(
  _workerIndex: number,
  name: string
): WorkerHost {
  const resourceLimits = config.transform.workerResourceLimits;
  const worker = new Worker(
    new URL('./workers/transform-worker.js', import.meta.url),
    {
      name,
      ...(resourceLimits ? { resourceLimits } : {}),
    }
  );

  return {
    kind: 'thread',
    supportsTransferList: true,
    threadId: worker.threadId,
    postMessage: (message, transferList) => {
      worker.postMessage(message, transferList);
    },
    terminate: async () => {
      await worker.terminate();
    },
    unref: () => {
      worker.unref();
    },
    onMessage: (handler) => {
      worker.on('message', handler);
    },
    onError: (handler) => {
      worker.on('error', handler);
      worker.on('messageerror', handler);
    },
    onExit: (handler) => {
      worker.on('exit', (code) => {
        handler(code, null);
      });
    },
  };
}

function createProcessWorkerHost(
  workerIndex: number,
  name: string
): WorkerHost {
  const child = fork(TRANSFORM_CHILD_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      ...process.env,
      FETCH_URL_MCP_WORKER_INDEX: String(workerIndex),
      FETCH_URL_MCP_WORKER_NAME: name,
    },
  });

  if (child.pid === undefined) {
    throw new Error('Failed to fork process');
  }

  return {
    kind: 'process',
    supportsTransferList: false,
    pid: child.pid,
    postMessage: (message) => {
      if (!child.connected) {
        throw new Error('Transform worker IPC channel is closed');
      }
      child.send(message);
    },
    terminate: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.killed) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        try {
          child.kill();
        } catch {
          resolve();
        }
      }),
    unref: () => {
      child.unref();
    },
    onMessage: (handler) => {
      child.on('message', handler);
    },
    onError: (handler) => {
      child.on('error', handler);
    },
    onExit: (handler) => {
      child.on('exit', (code, signal) => {
        handler(code, signal);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

class WorkerPool implements TransformWorkerPool {
  private static readonly CLOSED_MESSAGE = 'Transform worker pool closed';

  private readonly workers: (WorkerSlot | undefined)[] = [];
  private capacity: number;
  private readonly minCapacity = POOL_MIN_WORKERS;
  private readonly maxCapacity = POOL_MAX_WORKERS;

  private readonly queue: PendingTask[] = [];
  private queueHead = 0;
  private readonly inflight = new Map<string, InflightTask>();
  private readonly cancelAcks = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      timeout: CancellableTimeout<void>;
    }
  >();

  private readonly timeoutMs: number;
  private readonly queueMax: number;
  private readonly spawnWorkerImpl: WorkerSpawner;

  private closed = false;
  private taskIdSeq = 0;

  constructor(size: number, timeoutMs: number, spawnWorker: WorkerSpawner) {
    if (size === 0) {
      this.capacity = 0;
    } else {
      this.capacity = Math.max(
        this.minCapacity,
        Math.min(size, this.maxCapacity)
      );
    }
    this.timeoutMs = timeoutMs;
    this.queueMax = this.maxCapacity * 32;
    this.spawnWorkerImpl = spawnWorker;
  }

  async transform(
    html: string,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
      inputTruncated?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  async transform(
    htmlBuffer: Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
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
      skipNoiseRemoval?: boolean;
      inputTruncated?: boolean;
      encoding?: string;
    }
  ): Promise<MarkdownTransformResult> {
    this.ensureOpen();
    if (options.signal?.aborted)
      throw createAbortError(url, 'transform:enqueue');

    if (this.getQueueDepth() >= this.queueMax) {
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
      this.queue.push(task);
      this.drainQueue();
    });
  }

  getQueueDepth(): number {
    const depth = this.queue.length - this.queueHead;
    return depth > 0 ? depth : 0;
  }

  getActiveWorkers(): number {
    return this.workers.filter((s) => s?.busy).length;
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
      .map((slot) => slot?.host.terminate())
      .filter((p): p is Promise<void> => p !== undefined);

    this.workers.fill(undefined);
    this.workers.length = 0;

    for (const id of Array.from(this.inflight.keys())) {
      const inflight = this.takeInflight(id);
      if (!inflight) continue;
      this.finalizeTask(inflight.context, () => {
        inflight.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }

    for (let i = this.queueHead; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (!task) continue;
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }
    this.queue.length = 0;
    this.queueHead = 0;

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
      skipNoiseRemoval?: boolean;
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
      ...(options.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
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

    const queuedIndex = this.findQueuedIndex(id);
    if (queuedIndex !== null) {
      const task = this.queue[queuedIndex];
      if (task) this.clearAbortListener(task.signal, task.abortListener);

      this.queue.splice(queuedIndex, 1);
      if (task) {
        this.finalizeTask(task.context, () => {
          task.reject(createAbortError(url, 'transform:queued-abort'));
        });
      } else {
        this.finalizeTask(context, () => {
          reject(createAbortError(url, 'transform:queued-abort'));
        });
      }
      this.maybeCompactQueue();
    }
  }

  private resolveCancelAck(id: string): void {
    const pending = this.cancelAcks.get(id);
    if (!pending) return;
    pending.timeout.cancel();
    pending.resolve();
  }

  private waitForCancelAck(id: string): Promise<void> {
    const existing = this.cancelAcks.get(id);
    if (existing) {
      return existing.promise;
    }

    let resolve: () => void = () => {};
    const timeout = createUnrefTimeout(200, undefined);
    const racePromise = new Promise<void>((finish) => {
      resolve = finish;
    });

    const promise = Promise.race([racePromise, timeout.promise]).finally(() => {
      this.cancelAcks.delete(id);
      timeout.cancel();
    });

    this.cancelAcks.set(id, { promise, resolve, timeout });

    return promise;
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
        slot.host.postMessage({ type: 'cancel', id });
      } catch {
        // Worker may be unavailable; failure is acceptable during abort
      }
    }

    await this.waitForCancelAck(id);

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
    const host = this.spawnWorkerImpl(workerIndex, name);
    host.unref();

    host.onMessage((raw: unknown) => {
      this.onWorkerMessage(workerIndex, raw);
    });
    host.onError((error: unknown) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker error: ${getErrorMessage(error)}`
      );
    });
    host.onExit((code: number | null, signal: NodeJS.Signals | null) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.onWorkerBroken(workerIndex, `Transform worker exited (${suffix})`);
    });

    return { host, busy: false, currentTaskId: null, name };
  }

  private onWorkerBroken(workerIndex: number, message: string): void {
    if (this.closed) return;

    const slot = this.workers[workerIndex];
    if (!slot) return;

    logWarn('Transform worker unavailable; restarting', {
      reason: message,
      workerIndex,
      workerKind: slot.host.kind,
      workerName: slot.name,
      ...(slot.host.kind === 'process'
        ? { pid: slot.host.pid }
        : { threadId: slot.host.threadId }),
    });

    if (slot.busy && slot.currentTaskId) {
      this.failTask(
        slot.currentTaskId,
        new FetchError(message, '', 503, { reason: 'worker_exit' })
      );
    }

    this.restartWorker(workerIndex, slot);
  }

  private restartWorker(workerIndex: number, slot?: WorkerSlot): void {
    if (this.closed) return;

    const target = slot ?? this.workers[workerIndex];
    if (target) {
      target.host.terminate().catch(() => undefined);
    }

    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    if (!isWorkerResponse(raw)) return;

    const message = raw;

    if (message.type === 'cancelled') {
      this.resolveCancelAck(message.id);
      return;
    }

    const inflightPeek = this.inflight.get(message.id);
    if (inflightPeek?.cancelPending) {
      this.resolveCancelAck(message.id);
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
    slot.busy = false;
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
    if (this.closed || this.getQueueDepth() === 0) return;

    this.maybeScaleUp();

    for (let i = 0; i < this.workers.length; i += 1) {
      const slot = this.workers[i];
      if (slot && !slot.busy) {
        this.dispatchFromQueue(i, slot);
        if (this.getQueueDepth() === 0) return;
      }
    }

    if (this.workers.length < this.capacity && this.getQueueDepth() > 0) {
      const workerIndex = this.workers.length;
      const slot = this.spawnWorker(workerIndex);
      this.workers.push(slot);
      this.dispatchFromQueue(workerIndex, slot);

      if (this.workers.length < this.capacity && this.getQueueDepth() > 0) {
        setImmediate(() => {
          this.drainQueue();
        });
      }
    }
  }

  private takeNextQueuedTask(): PendingTask | null {
    while (this.queueHead < this.queue.length) {
      const task = this.queue[this.queueHead];
      this.queueHead += 1;

      if (task) {
        this.maybeCompactQueue();
        return task;
      }
    }

    this.maybeCompactQueue();
    return null;
  }

  private dispatchFromQueue(workerIndex: number, slot: WorkerSlot): void {
    const task = this.takeNextQueuedTask();
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

    const timeout = createUnrefTimeout(this.timeoutMs, null);
    void timeout.promise
      .then(() => {
        try {
          slot.host.postMessage({ type: 'cancel', id: task.id });
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

    try {
      const { message, transferList } = buildWorkerDispatchPayload(
        task,
        slot.host.supportsTransferList
      );
      slot.host.postMessage(message, transferList);
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

  private findQueuedIndex(id: string): number | null {
    for (let i = this.queueHead; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (task?.id === id) return i;
    }
    return null;
  }

  private maybeCompactQueue(): void {
    if (this.queueHead === 0) return;

    if (
      this.queueHead >= this.queue.length ||
      (this.queueHead > 1024 && this.queueHead > this.queue.length / 2)
    ) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Pool singleton management
// ---------------------------------------------------------------------------

let workerPool: WorkerPool | null = null;

function resolveWorkerSpawner(): WorkerSpawner {
  return config.transform.workerMode === 'process'
    ? createProcessWorkerHost
    : createThreadWorkerHost;
}

export function getOrCreateWorkerPool(): WorkerPool {
  const size = config.transform.maxWorkerScale === 0 ? 0 : POOL_MIN_WORKERS;
  workerPool ??= new WorkerPool(
    size,
    DEFAULT_TIMEOUT_MS,
    resolveWorkerSpawner()
  );
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
