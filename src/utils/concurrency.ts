/**
 * Concurrency limiter utility for controlling parallel async operations
 */

export type LimiterFn = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Creates a concurrency limiter that restricts the number of parallel executions
 * @param limit - Maximum number of concurrent operations (1-10)
 * @returns A function that wraps async operations with concurrency control
 */
export function createConcurrencyLimiter(limit: number): LimiterFn {
  // Validate and clamp limit
  const maxConcurrency = Math.min(Math.max(1, limit), 10);

  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Wait if at capacity
    while (active >= maxConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active++;
    try {
      return await fn();
    } finally {
      active--;
      // Release next waiting task
      const next = queue.shift();
      if (next) next();
    }
  };
}

/**
 * Executes an array of async functions with concurrency control
 * Uses Promise.allSettled for resilience - continues even if some fail
 * @param limit - Maximum concurrent operations
 * @param tasks - Array of async functions to execute
 * @returns Array of settled results (fulfilled or rejected)
 */
export async function runWithConcurrency<T>(
  limit: number,
  tasks: (() => Promise<T>)[]
): Promise<PromiseSettledResult<T>[]> {
  const limiter = createConcurrencyLimiter(limit);
  return Promise.allSettled(tasks.map(async (task) => limiter(task)));
}
