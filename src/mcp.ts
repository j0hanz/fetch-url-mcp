import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

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
import {
  logError,
  logInfo,
  logWarn,
  runWithRequestContext,
  setMcpServer,
} from './observability.js';
import { registerPrompts } from './prompts.js';
import { registerAgentsResource, registerConfigResource } from './resources.js';
import { type CreateTaskResult, taskManager, type TaskState } from './tasks.js';
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

async function getLocalIcons(
  signal?: AbortSignal
): Promise<McpIcon[] | undefined> {
  const MAX_ICON_BYTES = 2 * 1024 * 1024;

  try {
    const iconPath = new URL('./assets/logo.svg', import.meta.url);

    if (signal?.aborted) return undefined;
    const { size } = await stat(iconPath);
    if (size > MAX_ICON_BYTES) return undefined;

    const base64 = await readFile(iconPath, {
      encoding: 'base64',
      ...(signal ? { signal } : {}),
    });
    return [
      {
        src: `data:image/svg+xml;base64,${base64}`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      },
    ];
  } catch {
    return undefined;
  }
}

function createServerCapabilities(): {
  prompts: { listChanged: boolean };
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
    prompts: { listChanged: true },
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

async function createServerInstructions(
  serverVersion: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const raw = await readFile(new URL('./instructions.md', import.meta.url), {
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
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

const MIN_TASK_TTL_MS = 1_000;
const MAX_TASK_TTL_MS = 86_400_000;

const ExtendedCallToolRequestSchema: z.ZodType<ExtendedCallToolRequest> =
  z.looseObject({
    method: z.literal('tools/call'),
    params: z.looseObject({
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional(),
      task: z
        .object({
          ttl: z
            .number()
            .int()
            .min(MIN_TASK_TTL_MS)
            .max(MAX_TASK_TTL_MS)
            .optional(),
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

interface TaskStatusNotificationParams extends Record<string, unknown> {
  taskId: string;
  status: TaskState['status'];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
}

function buildTaskStatusParams(task: TaskState): TaskStatusNotificationParams {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttl: task.ttl,
    pollInterval: task.pollInterval,
  };
}

function emitTaskStatusNotification(server: McpServer, task: TaskState): void {
  if (!server.isConnected()) return;

  void server.server
    .notification({
      method: 'notifications/tasks/status',
      params: buildTaskStatusParams(task),
    } as { method: string; params: TaskStatusNotificationParams })
    .catch((error: unknown) => {
      logWarn('Failed to send task status notification', {
        taskId: task.taskId,
        status: task.status,
        error,
      });
    });
}

async function runFetchTaskExecution(params: {
  server: McpServer;
  taskId: string;
  args: { url: string };
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { server, taskId, args, meta, sendNotification } = params;

  return runWithRequestContext(
    { requestId: taskId, operationId: taskId },
    async () => {
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
          isRecord(result) &&
          typeof result.isError === 'boolean' &&
          result.isError;

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

        const task = taskManager.getTask(taskId);
        if (task) emitTaskStatusNotification(server, task);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
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

        const task = taskManager.getTask(taskId);
        if (task) emitTaskStatusNotification(server, task);
      } finally {
        clearTaskExecution(taskId);
      }
    }
  );
}

function handleTaskToolCall(
  server: McpServer,
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
    server,
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

  return fetchUrlToolHandler(args, {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.requestId !== undefined
      ? { requestId: context.requestId }
      : {}),
    ...(context.sendNotification
      ? { sendNotification: context.sendNotification }
      : {}),
    ...(params._meta ? { _meta: params._meta } : {}),
  });
}

async function handleToolCallRequest(
  server: McpServer,
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<ServerResult> {
  const { params } = request;

  if (params.task) {
    return handleTaskToolCall(server, params, context);
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
      const requestId =
        context.requestId !== undefined
          ? String(context.requestId)
          : randomUUID();

      const sessionId = (extra as HandlerExtra | undefined)?.sessionId;

      return runWithRequestContext(
        {
          requestId,
          operationId: requestId,
          ...(sessionId ? { sessionId } : {}),
        },
        () => {
          const parsed = parseExtendedCallToolRequest(request);
          return handleToolCallRequest(server, parsed, context);
        }
      );
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

    emitTaskStatusNotification(server, task);

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
  return createMcpServerWithOptions({ registerObservabilityServer: true });
}

interface CreateMcpServerOptions {
  registerObservabilityServer?: boolean;
}

async function createMcpServerWithOptions(
  options?: CreateMcpServerOptions
): Promise<McpServer> {
  const startupSignal = AbortSignal.timeout(5000);
  const [instructions, localIcons] = await Promise.all([
    createServerInstructions(config.server.version, startupSignal),
    getLocalIcons(startupSignal),
  ]);

  const serverInfo = createServerInfo(localIcons);
  const server = new McpServer(serverInfo, {
    capabilities: createServerCapabilities(),
    instructions,
  });

  if (options?.registerObservabilityServer ?? true) {
    setMcpServer(server);
  }

  registerTools(server);
  registerPrompts(server, instructions);
  registerCachedContentResource(server, localIcons);
  registerInstructionsResource(server, instructions);
  registerAgentsResource(server);
  registerConfigResource(server);
  registerTaskHandlers(server);

  return server;
}

export async function createMcpServerForHttpSession(): Promise<McpServer> {
  return createMcpServerWithOptions({ registerObservabilityServer: false });
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
        const error = err instanceof Error ? err : new Error(String(err));
        logError('Error during shutdown', error);
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.exitCode === undefined) process.exitCode = 0;
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
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to start stdio server: ${err.message}`, {
      cause: err,
    });
  }
}

export async function startStdioServer(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();

  attachServerErrorHandler(server);
  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
