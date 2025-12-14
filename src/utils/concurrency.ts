type LimiterFn = <T>(fn: () => Promise<T>) => Promise<T>;

interface ConcurrencyOptions {
  onProgress?: (completed: number, total: number) => void;
}

function createConcurrencyLimiter(limit: number): LimiterFn {
  const maxConcurrency = Math.min(Math.max(1, limit), 10);
  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= maxConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}
export async function runWithConcurrency<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
  options?: ConcurrencyOptions
): Promise<PromiseSettledResult<T>[]> {
  const limiter = createConcurrencyLimiter(limit);
  const total = tasks.length;
  let completed = 0;

  const wrappedTasks = tasks.map((task) => async () => {
    try {
      return await limiter(task);
    } finally {
      completed++;
      if (options?.onProgress) {
        options.onProgress(completed, total);
      }
    }
  });

  return Promise.allSettled(wrappedTasks.map(async (task) => task()));
}
