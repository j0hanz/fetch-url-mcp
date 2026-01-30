import { readFileSync } from 'node:fs';

import { z } from 'zod';

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type Result,
} from '@modelcontextprotocol/sdk/types.js';

import { type McpIcon, registerCachedContentResource } from './cache.js';
import { config } from './config.js';
import { destroyAgents } from './fetch.js';
import { logError, logInfo, setMcpServer } from './observability.js';
import { registerConfigResource } from './resources.js';
import { type CreateTaskResult, taskManager } from './tasks.js';
import {
  FETCH_URL_TOOL_NAME,
  fetchUrlToolHandler,
  registerTools,
} from './tools.js';
import { shutdownTransformWorkerPool } from './transform.js';
import { isObject } from './type-guards.js';

function getLocalIcons(): McpIcon[] | undefined {
  try {
    const iconPath = new URL('../assets/logo.svg', import.meta.url);
    const buffer = readFileSync(iconPath);
    return [
      {
        src: `data:image/svg+xml;base64,${buffer.toString('base64')}`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      },
    ];
  } catch {
    return undefined;
  }
}

function createServerInfo(): {
  name: string;
  version: string;
  icons?: McpIcon[];
} {
  const localIcons = getLocalIcons();

  return {
    name: config.server.name,
    version: config.server.version,
    ...(localIcons ? { icons: localIcons } : {}),
  };
}

function createServerCapabilities(): {
  tools: { listChanged: true };
  resources: { listChanged: true; subscribe: true };
  logging: Record<string, never>;
  tasks: {
    list: Record<string, never>;
    cancel: Record<string, never>;
    requests: {
      tools: {
        call: Record<string, never>;
      };
    };
  };
} {
  return {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    logging: {},
    tasks: {
      list: {},
      cancel: {},
      requests: {
        tools: {
          call: {},
        },
      },
    },
  };
}

function createServerInstructions(serverVersion: string): string {
  try {
    const raw = readFileSync(
      new URL('./instructions.md', import.meta.url),
      'utf8'
    );
    return raw.replaceAll('{{SERVER_VERSION}}', serverVersion).trim();
  } catch {
    return `Instructions unavailable | ${serverVersion}`;
  }
}

function registerInstructionsResource(
  server: McpServer,
  instructions: string
): void {
  server.registerResource(
    'instructions',
    new ResourceTemplate('internal://instructions', { list: undefined }),
    {
      title: `SuperFetch MCP | ${config.server.version}`,
      description: 'Guidance for using the superFetch MCP server.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: instructions,
        },
      ],
    })
  );
}

interface TaskGetRequest {
  method: 'tasks/get';
  params: {
    taskId: string;
    _meta?: {
      'io.modelcontextprotocol/related-task'?: never;
    };
  };
}

interface TaskCancelRequest {
  method: 'tasks/cancel';
  params: {
    taskId: string;
  };
}

interface TaskResultRequest {
  method: 'tasks/result';
  params: {
    taskId: string;
  };
}

// Schemas based on methods strings
const TaskGetSchema = z.object({ method: z.literal('tasks/get') });
const TaskListSchema = z.object({ method: z.literal('tasks/list') });
const TaskCancelSchema = z.object({ method: z.literal('tasks/cancel') });
const TaskResultSchema = z.object({ method: z.literal('tasks/result') });

// Type for interception
interface ExtendedCallToolRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    task?: {
      ttl?: number;
    };
    _meta?: {
      progressToken?: string | number;
    };
  };
}

function registerTaskHandlers(server: McpServer): void {
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const extendedParams = (request as unknown as ExtendedCallToolRequest)
      .params;
    const taskOptions = extendedParams.task;

    if (taskOptions) {
      // Validate tool support
      if (extendedParams.name !== FETCH_URL_TOOL_NAME) {
        throw new Error(
          `Tool '${extendedParams.name}' does not support task execution`
        );
      }

      // Create Task
      const task = taskManager.createTask(
        taskOptions.ttl !== undefined ? { ttl: taskOptions.ttl } : undefined
      );
      // Start Async Execution
      void (async () => {
        try {
          const args = extendedParams.arguments as unknown;

          if (
            !isObject(args) ||
            typeof (args as { url?: unknown }).url !== 'string'
          ) {
            throw new Error('Invalid arguments for fetch-url');
          }

          const validArgs = args as { url: string };
          const controller = new AbortController();

          const result = await fetchUrlToolHandler(validArgs, {
            signal: controller.signal,
            requestId: task.taskId, // Correlation
            ...(extendedParams._meta ? { _meta: extendedParams._meta } : {}),
          });
          // Update Task on Success
          taskManager.updateTask(task.taskId, {
            status: 'completed',
            result,
          });
        } catch (error) {
          // Update Task on Failure
          taskManager.updateTask(task.taskId, {
            status: 'failed',
            statusMessage:
              error instanceof Error ? error.message : String(error),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();

      // Return Immediate CreateTaskResult
      const response: CreateTaskResult = {
        task: {
          taskId: task.taskId,
          status: task.status,
          ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
          createdAt: task.createdAt,
          lastUpdatedAt: task.lastUpdatedAt,
          ttl: task.ttl,
          pollInterval: task.pollInterval,
        },
      };
      return response as unknown as { content: [] };
    }

    if (extendedParams.name === FETCH_URL_TOOL_NAME) {
      const args = extendedParams.arguments;

      if (
        !isObject(args) ||
        typeof (args as { url?: unknown }).url !== 'string'
      ) {
        throw new Error('Invalid arguments for fetch-url');
      }

      return fetchUrlToolHandler(
        { url: (args as { url: string }).url },
        {
          ...(extendedParams._meta ? { _meta: extendedParams._meta } : {}),
        }
      );
    }

    throw new Error(`Tool not found: ${extendedParams.name}`);
  });

  server.server.setRequestHandler(TaskGetSchema, async (request) => {
    const { taskId } = (request as unknown as TaskGetRequest).params;
    const task = taskManager.getTask(taskId);

    if (!task) {
      throw new Error('Task not found');
    }

    return Promise.resolve({
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttl: task.ttl,
      pollInterval: task.pollInterval,
    });
  });

  server.server.setRequestHandler(TaskResultSchema, async (request) => {
    const { taskId } = (request as unknown as TaskResultRequest).params;
    const task = taskManager.getTask(taskId);

    if (!task) {
      throw new Error('Task not found');
    }
    if (task.status === 'working' || task.status === 'input_required') {
      throw new Error('Task execution in progress');
    }
    if (task.status === 'failed') {
      return Promise.resolve(task.result ?? { isError: true, content: [] });
    }
    if (task.status === 'cancelled') {
      throw new Error('Task was cancelled');
    }
    const result = (task.result ?? { content: [] }) as Result;
    return Promise.resolve({
      ...result,
      _meta: {
        ...result._meta,
        'io.modelcontextprotocol/related-task': { taskId: task.taskId },
      },
    });
  });

  server.server.setRequestHandler(TaskListSchema, async () => {
    const tasks = taskManager.listTasks();
    return Promise.resolve({
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        createdAt: t.createdAt,
        lastUpdatedAt: t.lastUpdatedAt,
        ttl: t.ttl,
        pollInterval: t.pollInterval,
      })),
      nextCursor: undefined,
    });
  });

  server.server.setRequestHandler(TaskCancelSchema, async (request) => {
    const { taskId } = (request as unknown as TaskCancelRequest).params;

    const task = taskManager.cancelTask(taskId);
    if (!task) {
      throw new Error('Task not found');
    }

    return Promise.resolve({
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttl: task.ttl,
      pollInterval: task.pollInterval,
    });
  });
}

function registerPrompts(server: McpServer): void {
  if (config.tools.enabled.includes(FETCH_URL_TOOL_NAME)) {
    server.registerPrompt(
      'summarize-webpage',
      {
        description: 'Summarize the content of a webpage given its URL.',
        argsSchema: {
          url: z.string().describe('The URL to summarize'),
        },
      },
      (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please summarize the content of the webpage at the following URL: ${args.url}`,
            },
          },
        ],
      })
    );
  }
}

export function createMcpServer(): McpServer {
  const instructions = createServerInstructions(config.server.version);
  const server = new McpServer(createServerInfo(), {
    capabilities: createServerCapabilities(),
    instructions,
  });

  setMcpServer(server);
  const localIcons = getLocalIcons();
  registerTools(server);
  registerCachedContentResource(server, localIcons);
  registerInstructionsResource(server, instructions);
  registerConfigResource(server);
  registerTaskHandlers(server);
  registerPrompts(server);

  return server;
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };
}

function handleShutdownSignal(server: McpServer, signal: string): void {
  process.stderr.write(
    `\n${signal} received, shutting down superFetch MCP server...\n`
  );

  Promise.resolve()
    .then(async () => {
      destroyAgents();
      await shutdownTransformWorkerPool();
      await server.close();
    })
    .catch((err: unknown) => {
      logError('Error during shutdown', err instanceof Error ? err : undefined);
    })
    .finally(() => {
      process.exit(0);
    });
}

function createShutdownHandler(server: McpServer): (signal: string) => void {
  let shuttingDown = false;
  let initialSignal: string | null = null;

  return (signal: string): void => {
    if (shuttingDown) {
      logInfo('Shutdown already in progress; ignoring signal', {
        signal,
        initialSignal,
      });
      return;
    }

    shuttingDown = true;
    initialSignal = signal;
    handleShutdownSignal(server, signal);
  };
}

function registerSignalHandlers(handler: (signal: string) => void): void {
  process.once('SIGINT', () => {
    handler('SIGINT');
  });
  process.once('SIGTERM', () => {
    handler('SIGTERM');
  });
}

async function connectStdioServer(
  server: McpServer,
  transport: StdioServerTransport
): Promise<void> {
  try {
    await server.connect(transport);
    logInfo('superFetch MCP server running on stdio');
  } catch (error: unknown) {
    logError(
      'Failed to start stdio server',
      error instanceof Error ? error : undefined
    );
    process.exit(1);
  }
}

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  attachServerErrorHandler(server);
  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
