#!/usr/bin/env node
import process from 'node:process';

import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const args = new Set(process.argv.slice(2));
if (!args.has('--stdio')) {
  process.stderr.write('mock-fetch-url-server requires --stdio\n');
  process.exit(1);
}

const taskStore = new InMemoryTaskStore();
const taskQueue = new InMemoryTaskMessageQueue();

const server = new McpServer(
  { name: 'mock-fetch-url', version: '0.0.0' },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tools: {
            call: {},
          },
        },
      },
    },
    taskStore,
    taskMessageQueue: taskQueue,
  }
);

const inputSchema = z.strictObject({
  url: z.string(),
  skipNoiseRemoval: z.boolean().optional(),
  forceRefresh: z.boolean().optional(),
  maxInlineChars: z.number().optional(),
});

const outputSchema = z.strictObject({
  markdown: z.string(),
  cacheResourceUri: z.string().optional(),
});

server.experimental.tasks.registerToolTask(
  'fetch-url',
  {
    title: 'Mock Fetch URL',
    inputSchema,
    outputSchema,
    execution: { taskSupport: 'required' },
  },
  {
    createTask: async (input, extra) => {
      const task = await extra.taskStore.createTask({
        ttl: extra.taskRequestedTtl ?? undefined,
      });

      queueMicrotask(async () => {
        const structured = {
          markdown: `# Mock Fetch\n\nURL: ${input.url}\n`,
        };

        const result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(structured),
            },
          ],
          structuredContent: structured,
        };

        await extra.taskStore.storeTaskResult(task.taskId, 'completed', result);
      });

      return { task };
    },
    getTask: async (_input, extra) => {
      const task = await extra.taskStore.getTask(extra.taskId);
      if (!task) {
        throw new Error(`Task not found: ${extra.taskId}`);
      }
      return task;
    },
    getTaskResult: async (_input, extra) =>
      extra.taskStore.getTaskResult(extra.taskId),
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
