import { readFile } from 'node:fs/promises';

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
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { type McpIcon, registerCachedContentResource } from './cache.js';
import { config } from './config.js';
import { logError, logInfo, setMcpServer } from './observability.js';
import { registerConfigResource } from './resources.js';
import { type CreateTaskResult, taskManager } from './tasks.js';
import {
  FETCH_URL_TOOL_NAME,
  fetchUrlInputSchema,
  fetchUrlToolHandler,
  type ProgressNotification,
  registerTools,
} from './tools.js';
import { shutdownTransformWorkerPool } from './transform.js';
import { isObject } from './type-guards.js';

/* -------------------------------------------------------------------------------------------------
 * Icons + server info
 * ------------------------------------------------------------------------------------------------- */

async function getLocalIcons(): Promise<McpIcon[] | undefined> {
  try {
    const iconPath = new URL('../assets/logo.svg', import.meta.url);
    const buffer = await readFile(iconPath);
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

function createServerCapabilities(): {
  tools: { listChanged: boolean };
  resources: { listChanged: boolean; subscribe: boolean };
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
    tools: { listChanged: false },
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

async function createServerInstructions(
  serverVersion: string
): Promise<string> {
  try {
    const raw = await readFile(
      new URL('./instructions.md', import.meta.url),
      'utf8'
    );
    return raw.replaceAll('{{SERVER_VERSION}}', serverVersion).trim();
  } catch {
    return `Instructions unavailable | ${serverVersion}`;
  }
}

function createServerInfo(icons?: McpIcon[]): {
  name: string;
  version: string;
  icons?: McpIcon[];
} {
  return {
    name: config.server.name,
    version: config.server.version,
    ...(icons ? { icons } : {}),
  };
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

/* -------------------------------------------------------------------------------------------------
 * Tasks API schemas
 * ------------------------------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------------------------------
 * Tool call interception (tools/call) with task support
 * ------------------------------------------------------------------------------------------------- */

interface ExtendedCallToolRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
    task?:
      | {
          ttl?: number | undefined;
        }
      | undefined;
    _meta?:
      | {
          progressToken?: string | number | undefined;
          'io.modelcontextprotocol/related-task'?:
            | { taskId: string }
            | undefined;
          [key: string]: unknown;
        }
      | undefined;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const ExtendedCallToolRequestSchema: z.ZodType<ExtendedCallToolRequest> =
  z.looseObject({
    method: z.literal('tools/call'),
    params: z.looseObject({
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional(),
      task: z
        .object({
          ttl: z.number().optional(),
        })
        .optional(),
      _meta: z
        .looseObject({
          progressToken: z.union([z.string(), z.number()]).optional(),
          'io.modelcontextprotocol/related-task': z
            .object({
              taskId: z.string(),
            })
            .optional(),
        })
        .optional(),
    }),
  });

function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = ExtendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw new McpError(ErrorCode.InvalidParams, 'Invalid tool request');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
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
  const parsed = fetchUrlInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid arguments for fetch-url'
    );
  }
  return parsed.data;
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

/**
 * Track in-flight task executions so `tasks/cancel` can actually abort work.
 * This is intentionally local to this module (no new files, no global singletons elsewhere).
 */
const taskAbortControllers = new Map<string, AbortController>();

function attachAbortController(taskId: string): AbortController {
  const existing = taskAbortControllers.get(taskId);
  if (existing) {
    // Defensive: should not happen, but avoid leaking the old controller.
    taskAbortControllers.delete(taskId);
  }
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller;
}

function abortTaskExecution(taskId: string): void {
  const controller = taskAbortControllers.get(taskId);
  if (!controller) return;
  controller.abort();
  taskAbortControllers.delete(taskId);
}

function clearTaskExecution(taskId: string): void {
  taskAbortControllers.delete(taskId);
}

async function runFetchTaskExecution(params: {
  taskId: string;
  args: { url: string };
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { taskId, args, meta, sendNotification } = params;

  const controller = attachAbortController(taskId);

  try {
    const relatedMeta = buildRelatedTaskMeta(taskId, meta);

    const result = await fetchUrlToolHandler(args, {
      signal: controller.signal,
      requestId: taskId, // Correlation
      _meta: relatedMeta,
      ...(sendNotification ? { sendNotification } : {}),
    });

    const isToolError =
      isRecord(result) && typeof result.isError === 'boolean' && result.isError;

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
  } catch (error: unknown) {
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
  } finally {
    clearTaskExecution(taskId);
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

  void runFetchTaskExecution({
    taskId: task.taskId,
    args: validArgs,
    ...(params._meta ? { meta: params._meta } : {}),
    ...(context.sendNotification
      ? { sendNotification: context.sendNotification }
      : {}),
  });

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
): Promise<ServerResult> {
  const args = requireFetchUrlArgs(params.arguments);

  return fetchUrlToolHandler(
    { url: args.url },
    {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.requestId !== undefined
        ? { requestId: context.requestId }
        : {}),
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
): Promise<ServerResult> {
  const { params } = request;

  if (params.task) {
    return handleTaskToolCall(params, context);
  }

  if (params.name === FETCH_URL_TOOL_NAME) {
    return handleDirectToolCall(params, context);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
}

/* -------------------------------------------------------------------------------------------------
 * Register handlers
 * ------------------------------------------------------------------------------------------------- */

function registerTaskHandlers(server: McpServer): void {
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const context = resolveToolCallContext(extra as HandlerExtra | undefined);
      const parsed = parseExtendedCallToolRequest(request);
      return handleToolCallRequest(parsed, context);
    }
  );

  server.server.setRequestHandler(TaskGetSchema, async (request, extra) => {
    const { taskId } = request.params;
    const ownerKey = resolveTaskOwnerKey(extra as HandlerExtra | undefined);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

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

    if (!task) throwTaskNotFound();

    if (task.status === 'failed') {
      if (task.error) {
        throw new McpError(
          task.error.code,
          task.error.message,
          task.error.data
        );
      }

      const failedResult = (task.result ?? null) as ServerResult | null;
      const fallback: ServerResult = failedResult ?? {
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

    const result = (task.result ?? { content: [] }) as ServerResult;

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
    if (!task) throwTaskNotFound();

    // Make cancellation actionable: abort any in-flight execution.
    abortTaskExecution(taskId);

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

/* -------------------------------------------------------------------------------------------------
 * Server lifecycle
 * ------------------------------------------------------------------------------------------------- */

export async function createMcpServer(): Promise<McpServer> {
  const [instructions, localIcons] = await Promise.all([
    createServerInstructions(config.server.version),
    getLocalIcons(),
  ]);

  const serverInfo = createServerInfo(localIcons);
  const server = new McpServer(serverInfo, {
    capabilities: createServerCapabilities(),
    instructions,
  });

  setMcpServer(server);

  registerTools(server);
  registerCachedContentResource(server, localIcons);
  registerInstructionsResource(server, instructions);
  registerConfigResource(server);
  registerTaskHandlers(server);

  return server;
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };
}

async function shutdownServer(
  server: McpServer,
  signal: string
): Promise<void> {
  process.stderr.write(
    `\n${signal} received, shutting down superFetch MCP server...\n`
  );

  // Ensure any in-flight tool executions are aborted promptly.
  for (const taskId of taskAbortControllers.keys()) abortTaskExecution(taskId);

  await shutdownTransformWorkerPool();
  await server.close();
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

    Promise.resolve()
      .then(() => shutdownServer(server, signal))
      .catch((err: unknown) => {
        logError(
          'Error during shutdown',
          err instanceof Error ? err : undefined
        );
      })
      .finally(() => {
        process.exit(0);
      });
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
  const server = await createMcpServer();
  const transport = new StdioServerTransport();

  attachServerErrorHandler(server);
  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
