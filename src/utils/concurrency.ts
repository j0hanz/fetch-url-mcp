type LimiterFn = <T>(fn: () => Promise<T>) => Promise<T>;

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
  tasks: (() => Promise<T>)[]
): Promise<PromiseSettledResult<T>[]> {
  const limiter = createConcurrencyLimiter(limit);
  return Promise.allSettled(tasks.map(async (task) => limiter(task)));
}
