import type {
  ConcurrencyExecutionOptions,
  ConcurrencyLimitedExecutor,
} from '../config/types.js';

const MAX_CONCURRENCY_LIMIT = 10;
const MIN_CONCURRENCY = 1;

function createConcurrencyLimiter(limit: number): ConcurrencyLimitedExecutor {
  const maxConcurrency = Math.min(
    Math.max(MIN_CONCURRENCY, limit),
    MAX_CONCURRENCY_LIMIT
  );

  let activeCount = 0;
  const waitingQueue: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (activeCount >= maxConcurrency) {
      await new Promise<void>((resolve) => waitingQueue.push(resolve));
    }

    activeCount++;
    try {
      return await task();
    } finally {
      activeCount--;
      const nextWaiting = waitingQueue.shift();
      if (nextWaiting) nextWaiting();
    }
  };
}

export async function runWithConcurrency<T>(
  limit: number,
  tasks: readonly (() => Promise<T>)[],
  options?: ConcurrencyExecutionOptions
): Promise<PromiseSettledResult<T>[]> {
  const limiter = createConcurrencyLimiter(limit);
  const totalTasks = tasks.length;
  let completedCount = 0;

  const wrappedTasks = tasks.map((task) => async (): Promise<T> => {
    try {
      return await limiter(task);
    } finally {
      completedCount++;
      options?.onProgress?.(completedCount, totalTasks);
    }
  });

  return Promise.allSettled(wrappedTasks.map((task) => task()));
}
