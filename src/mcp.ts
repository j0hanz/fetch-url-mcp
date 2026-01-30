import { readFileSync } from 'node:fs';

import { z } from 'zod';

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
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
  type ProgressNotification,
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
  prompts: Record<string, never>;
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
    prompts: {},
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

// Schemas based on methods strings
const TaskGetSchema = z.object({
  method: z.literal('tasks/get'),
  params: z.object({ taskId: z.string() }),
});
const TaskListSchema = z.object({
  method: z.literal('tasks/list'),
  params: z
    .object({
      cursor: z.string().optional(),
    })
    .optional(),
});
const TaskCancelSchema = z.object({
  method: z.literal('tasks/cancel'),
  params: z.object({ taskId: z.string() }),
});
const TaskResultSchema = z.object({
  method: z.literal('tasks/result'),
  params: z.object({ taskId: z.string() }),
});

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
      'io.modelcontextprotocol/related-task'?: { taskId: string };
    };
  };
}

interface HandlerExtra {
  sessionId?: string;
  authInfo?: { clientId?: string; token?: string };
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

interface ToolCallContext {
  ownerKey: string;
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

function resolveTaskOwnerKey(extra?: HandlerExtra): string {
  if (extra?.sessionId) return `session:${extra.sessionId}`;
  if (extra?.authInfo?.clientId) return `client:${extra.authInfo.clientId}`;
  if (extra?.authInfo?.token) return `token:${extra.authInfo.token}`;
  return 'default';
}

function resolveToolCallContext(extra?: HandlerExtra): ToolCallContext {
  const context: ToolCallContext = {
    ownerKey: resolveTaskOwnerKey(extra),
  };

  if (extra?.signal) context.signal = extra.signal;
  if (extra?.requestId !== undefined) context.requestId = extra.requestId;
  if (extra?.sendNotification)
    context.sendNotification = extra.sendNotification;

  return context;
}

function requireFetchUrlArgs(args: unknown): { url: string } {
  if (!isObject(args) || typeof (args as { url?: unknown }).url !== 'string') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid arguments for fetch-url'
    );
  }
  return { url: (args as { url: string }).url };
}

function throwTaskNotFound(): never {
  throw new McpError(
    ErrorCode.InvalidParams,
    'Failed to retrieve task: Task not found'
  );
}

function requireFetchUrlToolName(name: string): void {
  if (name === FETCH_URL_TOOL_NAME) return;
  throw new McpError(
    ErrorCode.MethodNotFound,
    `Tool '${name}' does not support task execution`
  );
}

function buildRelatedTaskMeta(
  taskId: string,
  meta?: ExtendedCallToolRequest['params']['_meta']
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    'io.modelcontextprotocol/related-task': { taskId },
  };
}

function buildCreateTaskResult(
  task: CreateTaskResult['task']
): CreateTaskResult {
  return {
    task,
    _meta: {
      'io.modelcontextprotocol/related-task': {
        taskId: task.taskId,
        status: task.status,
        ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
        createdAt: task.createdAt,
        lastUpdatedAt: task.lastUpdatedAt,
        ttl: task.ttl,
        pollInterval: task.pollInterval,
      },
    },
  };
}

async function runFetchTaskExecution(params: {
  taskId: string;
  args: { url: string };
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { taskId, args, meta, sendNotification } = params;

  try {
    const controller = new AbortController();
    const relatedMeta = buildRelatedTaskMeta(taskId, meta);

    const result = await fetchUrlToolHandler(args, {
      signal: controller.signal,
      requestId: taskId, // Correlation
      _meta: relatedMeta,
      ...(sendNotification ? { sendNotification } : {}),
    });

    const isToolError =
      typeof (result as { isError?: boolean }).isError === 'boolean'
        ? (result as { isError?: boolean }).isError
        : false;

    taskManager.updateTask(taskId, {
      status: isToolError ? 'failed' : 'completed',
      ...(isToolError
        ? {
            statusMessage:
              (result as { structuredContent?: { error?: string } })
                .structuredContent?.error ?? 'Tool execution failed',
          }
        : {}),
      result,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorPayload =
      error instanceof McpError
        ? {
            code: error.code,
            message: errorMessage,
            data: error.data,
          }
        : {
            code: ErrorCode.InternalError,
            message: errorMessage,
          };
    taskManager.updateTask(taskId, {
      status: 'failed',
      statusMessage: errorMessage,
      error: errorPayload,
    });
  }
}

function handleTaskToolCall(
  params: ExtendedCallToolRequest['params'],
  context: ToolCallContext
): CreateTaskResult {
  requireFetchUrlToolName(params.name);
  const validArgs = requireFetchUrlArgs(params.arguments);
  const task = taskManager.createTask(
    params.task?.ttl !== undefined ? { ttl: params.task.ttl } : undefined,
    'Task started',
    context.ownerKey
  );

  const executionParams: {
    taskId: string;
    args: { url: string };
    meta?: ExtendedCallToolRequest['params']['_meta'];
    sendNotification?: (notification: ProgressNotification) => Promise<void>;
  } = {
    taskId: task.taskId,
    args: validArgs,
    ...(params._meta ? { meta: params._meta } : {}),
    ...(context.sendNotification
      ? { sendNotification: context.sendNotification }
      : {}),
  };

  void runFetchTaskExecution(executionParams);

  return buildCreateTaskResult({
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    pollInterval: task.pollInterval,
  });
}

async function handleDirectToolCall(
  params: ExtendedCallToolRequest['params'],
  context: ToolCallContext
): Promise<Result> {
  const args = requireFetchUrlArgs(params.arguments);
  return fetchUrlToolHandler(
    { url: args.url },
    {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.sendNotification
        ? { sendNotification: context.sendNotification }
        : {}),
      ...(params._meta ? { _meta: params._meta } : {}),
    }
  );
}

async function handleToolCallRequest(
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<Result | CreateTaskResult> {
  const { params } = request;

  if (params.task) {
    return handleTaskToolCall(params, context);
  }

  if (params.name === FETCH_URL_TOOL_NAME) {
    return handleDirectToolCall(params, context);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
}

function registerTaskHandlers(server: McpServer): void {
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const extendedRequest = request as unknown as ExtendedCallToolRequest;
      const context = resolveToolCallContext(extra as HandlerExtra | undefined);
      const result = await handleToolCallRequest(extendedRequest, context);
      return result as unknown as { content: [] };
    }
  );

  server.server.setRequestHandler(TaskGetSchema, async (request, extra) => {
    const { taskId } = request.params;
    const ownerKey = resolveTaskOwnerKey(extra as HandlerExtra | undefined);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) {
      throwTaskNotFound();
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

  server.server.setRequestHandler(TaskResultSchema, async (request, extra) => {
    const { taskId } = request.params;
    const ownerKey = resolveTaskOwnerKey(extra as HandlerExtra | undefined);
    const task = await taskManager.waitForTerminalTask(
      taskId,
      ownerKey,
      (extra as HandlerExtra | undefined)?.signal
    );

    if (!task) {
      throwTaskNotFound();
    }
    if (task.status === 'failed') {
      if (task.error) {
        throw new McpError(
          task.error.code,
          task.error.message,
          task.error.data
        );
      }
      const failedResult = (task.result ?? null) as Result | null;
      const fallback: Result = failedResult ?? {
        content: [
          {
            type: 'text',
            text: task.statusMessage ?? 'Task execution failed',
          },
        ],
        isError: true,
      };
      return Promise.resolve({
        ...fallback,
        _meta: {
          ...fallback._meta,
          'io.modelcontextprotocol/related-task': { taskId: task.taskId },
        },
      });
    }
    if (task.status === 'cancelled') {
      throw new McpError(ErrorCode.InvalidRequest, 'Task was cancelled');
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

  server.server.setRequestHandler(TaskListSchema, async (request, extra) => {
    const ownerKey = resolveTaskOwnerKey(extra as HandlerExtra | undefined);
    const cursor = request.params?.cursor;
    const { tasks, nextCursor } = taskManager.listTasks(
      cursor === undefined ? { ownerKey } : { ownerKey, cursor }
    );
    return Promise.resolve({
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        createdAt: t.createdAt,
        lastUpdatedAt: t.lastUpdatedAt,
        ttl: t.ttl,
        pollInterval: t.pollInterval,
      })),
      nextCursor,
    });
  });

  server.server.setRequestHandler(TaskCancelSchema, async (request, extra) => {
    const { taskId } = request.params;
    const ownerKey = resolveTaskOwnerKey(extra as HandlerExtra | undefined);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) {
      throwTaskNotFound();
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
