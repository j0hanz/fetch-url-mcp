import { describe, expect, test } from 'vitest';

import { runWithConcurrency } from '../../../src/utils/concurrency.js';

describe('concurrency', () => {
  describe('runWithConcurrency', () => {
    test('executes tasks with limit of 1 (sequential)', async () => {
      const executionOrder: number[] = [];
      const tasks = [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push(1);
          return 1;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          executionOrder.push(2);
          return 2;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push(3);
          return 3;
        },
      ];

      const results = await runWithConcurrency(1, tasks);

      expect(results).toHaveLength(3);
      expect(executionOrder).toEqual([1, 2, 3]);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });
    });

    test('executes tasks with limit of 3 (parallel)', async () => {
      const startTimes: number[] = [];
      const tasks = [
        async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 1;
        },
        async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 2;
        },
        async () => {
          startTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 3;
        },
      ];

      const start = Date.now();
      const results = await runWithConcurrency(3, tasks);
      const duration = Date.now() - start;

      expect(results).toHaveLength(3);
      // All tasks should start roughly at the same time (within 20ms)
      const timeDiffs = startTimes.map((time) => time - start);
      timeDiffs.forEach((diff) => {
        expect(diff).toBeLessThan(20);
      });

      // Total duration should be ~50ms (parallel) not ~150ms (sequential)
      expect(duration).toBeLessThan(100);
      expect(duration).toBeGreaterThan(40);
    });

    test('respects concurrency limit', async () => {
      let activeCount = 0;
      let maxActive = 0;

      const tasks = Array.from({ length: 10 }, (_, i) => async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCount--;
        return i;
      });

      await runWithConcurrency(3, tasks);

      expect(maxActive).toBe(3);
    });

    test('returns all settled results', async () => {
      const tasks = [
        async () => 1,
        async () => {
          throw new Error('Task 2 failed');
        },
        async () => 3,
        async () => {
          throw new Error('Task 4 failed');
        },
        async () => 5,
      ];

      const results = await runWithConcurrency(2, tasks);

      expect(results).toHaveLength(5);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
      expect(results[3].status).toBe('rejected');
      expect(results[4].status).toBe('fulfilled');

      if (results[0].status === 'fulfilled') {
        expect(results[0].value).toBe(1);
      }
      if (results[1].status === 'rejected') {
        expect(results[1].reason).toBeInstanceOf(Error);
      }
    });

    test('handles empty task array', async () => {
      const results = await runWithConcurrency(3, []);

      expect(results).toHaveLength(0);
      expect(results).toEqual([]);
    });

    test('handles single task', async () => {
      const tasks = [async () => 42];

      const results = await runWithConcurrency(3, tasks);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled') {
        expect(results[0].value).toBe(42);
      }
    });

    test('clamps concurrency limit to maximum', async () => {
      // Even with limit > 10, internal max should be 10
      const tasks = Array.from({ length: 5 }, (_, i) => async () => i);

      const results = await runWithConcurrency(20, tasks);

      expect(results).toHaveLength(5);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });
    });

    test('clamps concurrency limit to minimum', async () => {
      // Even with limit 0 or negative, should execute with limit 1
      const tasks = [async () => 1, async () => 2];

      const results = await runWithConcurrency(0, tasks);

      expect(results).toHaveLength(2);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });
    });

    test('handles tasks with different durations', async () => {
      const completionOrder: number[] = [];
      const tasks = [
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          completionOrder.push(1);
          return 1;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          completionOrder.push(2);
          return 2;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          completionOrder.push(3);
          return 3;
        },
      ];

      const results = await runWithConcurrency(3, tasks);

      expect(results).toHaveLength(3);
      // Shorter tasks should complete first
      expect(completionOrder[0]).toBe(2);
      expect(completionOrder[1]).toBe(3);
      expect(completionOrder[2]).toBe(1);
    });

    test('continues after task failure', async () => {
      const tasks = [
        async () => {
          throw new Error('Fail');
        },
        async () => 'success',
      ];

      const results = await runWithConcurrency(2, tasks);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      if (results[1].status === 'fulfilled') {
        expect(results[1].value).toBe('success');
      }
    });
  });
});
