import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
  type ServerResult,
} from '@modelcontextprotocol/server';

import { hash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { config } from '../lib/config.js';
import {
  getRequestId,
  logDebug,
  logError,
  Loggers,
  logInfo,
  logWarn,
  resolveMcpSessionOwnerKey,
  runWithRequestContext,
  runWithTraceContext,
} from '../lib/core.js';
import {
  getErrorMessage,
  handleToolError,
  stripProtocolErrorPrefix,
  tryReadToolErrorMessage,
} from '../lib/error/index.js';
import {
  createProtocolError,
  getSdkCallToolHandler,
  type ProgressNotification,
  registerServerLifecycleCleanup,
  type ToolHandlerExtra,
} from '../lib/mcp-interop.js';
import { formatZodError, isObject } from '../lib/utils.js';

import {
  type CreateTaskResult,
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
  type TaskState,
  type TaskStatus,
  TaskWaiterRegistry,
  waitForTerminalTask,
} from './store.js';

/*
 * Module map:
 * - call-tool request parsing
 * - Abort-controller management for in-flight task executions
 * - Task notification and validation helpers
 * - Execution pipeline
 * - Task handler schemas and registration
 * - Handler extra parsing & owner-key resolution
 * Own task lifecycle and MCP task wiring here. Keep tool business logic and HTTP transport details elsewhere.
 */

const MIN_TASK_KEEP_ALIVE_MS = 1_000;
const MAX_TASK_KEEP_ALIVE_MS = 86_400_000;
const RELATED_TASK_META_KEY = 'modelcontextprotocol.io/related-task';

const taskMetaSchema = z.strictObject({
  taskId: z.string().min(1, 'Task id required'),
  keepAlive: z
    .number()
    .int()
    .min(MIN_TASK_KEEP_ALIVE_MS, `Minimum ${MIN_TASK_KEEP_ALIVE_MS}ms`)
    .max(MAX_TASK_KEEP_ALIVE_MS, `Maximum ${MAX_TASK_KEEP_ALIVE_MS}ms`)
    .optional(),
});

const relatedTaskMetaSchema = z.strictObject({
  taskId: z.string(),
});

const toolCallMetaSchema = z.looseObject({
  progressToken: z.union([z.string(), z.number()]).optional(),
  'modelcontextprotocol.io/task': taskMetaSchema.optional(),
  [RELATED_TASK_META_KEY]: relatedTaskMetaSchema.optional(),
});

const sdkTaskParamsSchema = z.object({ ttl: z.number().optional() }).optional();

export const extendedCallToolRequestSchema = z.looseObject({
  method: z.literal('tools/call'),
  params: z.strictObject({
    name: z.string().min(1, 'Tool name required'),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: toolCallMetaSchema.optional(),
    task: sdkTaskParamsSchema,
  }),
});

export type ExtendedCallToolRequest = z.infer<
  typeof extendedCallToolRequestSchema
>;
export type ToolCallRequestMeta = ExtendedCallToolRequest['params']['_meta'];
type TaskMeta = NonNullable<
  NonNullable<ToolCallRequestMeta>['modelcontextprotocol.io/task']
>;

export {
  decodeTaskCursor,
  encodeTaskCursor,
  taskManager,
  TaskWaiterRegistry,
  waitForTerminalTask,
};
export type { CreateTaskResult, TaskState, TaskStatus };

function getTaskMeta(
  params: ExtendedCallToolRequest['params']
): TaskMeta | undefined {
  const legacyMeta = params._meta?.['modelcontextprotocol.io/task'];
  if (legacyMeta) return legacyMeta;
  if (params.task) {
    return {
      taskId: randomUUID(),
      ...(params.task.ttl !== undefined ? { keepAlive: params.task.ttl } : {}),
    };
  }

  return undefined;
}

export function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = extendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;

  throw createProtocolError(
    ProtocolErrorCode.InvalidParams,
    formatZodError(parsed.error)
  );
}

export function sanitizeToolCallMeta(
  meta?: ToolCallRequestMeta
): ToolCallRequestMeta | undefined {
  if (!meta) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(meta).filter(([key]) => key !== RELATED_TASK_META_KEY)
  ) as NonNullable<ToolCallRequestMeta>;
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildRelatedTaskMeta(
  taskId: string,
  meta?: ToolCallRequestMeta
): Record<string, unknown> {
  return {
    ...(sanitizeToolCallMeta(meta) ?? {}),
    [RELATED_TASK_META_KEY]: { taskId },
  };
}

export function withRelatedTaskMeta(
  result: ServerResult,
  taskId: string
): ServerResult {
  return {
    ...result,
    _meta: {
      ...result._meta,
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

function withRelatedTaskSummaryMeta<T extends Record<string, unknown>>(
  payload: T,
  taskId: string
): T & { _meta: Record<string, unknown> } {
  return {
    ...payload,
    _meta: {
      ...(isObject(payload['_meta']) ? payload['_meta'] : {}),
      [RELATED_TASK_META_KEY]: { taskId },
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Abort-controller management for in-flight task executions
 * ------------------------------------------------------------------------------------------------- */

// Intentionally process-global (not session-scoped): abortAllTaskExecutions() is called
// during SIGTERM/SIGINT shutdown to cancel every in-flight task across all sessions.
const taskAbortControllers = new Map<string, AbortController>();

function detachAbortController(taskId: string): AbortController | undefined {
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    taskAbortControllers.delete(taskId);
  }
  return controller;
}

function attachAbortController(taskId: string): AbortController {
  detachAbortController(taskId)?.abort();

  if (taskAbortControllers.size >= config.tasks.maxTotal) {
    logWarn(
      'Abort controller map reached task capacity — possible leak',
      {
        size: taskAbortControllers.size,
        maxTotal: config.tasks.maxTotal,
      },
      Loggers.LOG_TASKS
    );
  }

  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller;
}

export function abortTaskExecution(taskId: string): void {
  detachAbortController(taskId)?.abort();
}

export function cancelTasksForOwner(
  ownerKey: string,
  statusMessage = 'The task was cancelled because its owner session ended.'
): number {
  if (!ownerKey) return 0;
  const cancelled = taskManager.cancelTasksByOwner(ownerKey, statusMessage);
  for (const task of cancelled) {
    abortTaskExecution(task.taskId);
  }
  return cancelled.length;
}

export function abortAllTaskExecutions(): void {
  for (const taskId of taskAbortControllers.keys()) abortTaskExecution(taskId);
}

/* -------------------------------------------------------------------------------------------------
 * Task notification and validation helpers
 * ------------------------------------------------------------------------------------------------- */

type TaskSummary = CreateTaskResult['task'];
type TaskLifecycleProjection = Pick<
  TaskState,
  | 'taskId'
  | 'status'
  | 'statusMessage'
  | 'progress'
  | 'total'
  | 'createdAt'
  | 'lastUpdatedAt'
  | 'keepAlive'
  | 'pollFrequency'
>;

export function toTaskSummary(task: TaskLifecycleProjection): TaskSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    ...(task.progress !== undefined ? { progress: task.progress } : {}),
    ...(task.total !== undefined ? { total: task.total } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    keepAlive: task.keepAlive,
    pollFrequency: task.pollFrequency,
    ttl: task.keepAlive,
    pollInterval: task.pollFrequency,
  };
}

export function emitTaskStatusNotification(
  server: McpServer,
  task: TaskState
): void {
  if (!config.tasks.emitStatusNotifications || !server.isConnected()) return;

  void server.server
    .notification({
      method: 'notifications/tasks/status',
      params: withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId),
    })
    .catch((error: unknown) => {
      logError(
        'Failed to send task status notification',
        {
          taskId: task.taskId,
          status: task.status,
          error: getErrorMessage(error),
        },
        Loggers.LOG_TASKS
      );
    });
}

function emitTaskCreatedNotification(server: McpServer, task: TaskState): void {
  if (!config.tasks.emitStatusNotifications || !server.isConnected()) return;

  void server.server
    .notification({
      method: 'notifications/tasks/created',
      params: {
        _meta: {
          [RELATED_TASK_META_KEY]: { taskId: task.taskId },
        },
      },
    })
    .catch((error: unknown) => {
      logError(
        'Failed to send task created notification',
        {
          taskId: task.taskId,
          error: getErrorMessage(error),
        },
        Loggers.LOG_TASKS
      );
    });
}

export function throwTaskNotFound(): never {
  throw createProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found');
}

/* -------------------------------------------------------------------------------------------------
 * Execution pipeline
 * ------------------------------------------------------------------------------------------------- */

function updateTaskAndEmitStatus(
  server: McpServer,
  taskId: string,
  update: Parameters<(typeof taskManager)['updateTask']>[1]
): void {
  taskManager.updateTask(taskId, update);
  const task = taskManager.getTask(taskId);
  if (task) emitTaskStatusNotification(server, task);
}

function buildTaskFailureState(error: unknown): {
  status: 'failed';
  statusMessage: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
} {
  const mcpErrorMessage =
    error instanceof ProtocolError
      ? stripProtocolErrorPrefix(error.message)
      : undefined;
  const statusMessage = mcpErrorMessage ?? getErrorMessage(error);

  if (error instanceof ProtocolError) {
    return {
      status: 'failed',
      statusMessage,
      error: {
        code: error.code,
        ...(error.data !== undefined ? { data: error.data } : {}),
        message: statusMessage,
      },
    };
  }

  return {
    status: 'failed',
    statusMessage,
    error: {
      code: ProtocolErrorCode.InternalError,
      message: statusMessage,
    },
  };
}

function buildTaskCompletionUpdate(
  result: Awaited<ReturnType<TaskCapableToolDescriptor['execute']>>,
  tool: TaskCapableToolDescriptor
): Parameters<(typeof taskManager)['updateTask']>[1] {
  const isError =
    isObject(result) && 'isError' in result && result.isError === true;
  const errorMessage = tryReadToolErrorMessage(result) ?? 'Execution failed';

  return {
    status: isError ? 'failed' : 'completed',
    statusMessage: isError
      ? errorMessage
      : (tool.getCompletionStatusMessage?.(result) ??
        'Task completed successfully.'),
    result,
    ...(isError
      ? {
          error: {
            code: ProtocolErrorCode.InternalError,
            message: errorMessage,
          },
        }
      : {}),
  };
}

async function runTaskToolExecution(params: {
  server: McpServer;
  taskId: string;
  args: unknown;
  tool: TaskCapableToolDescriptor;
  meta?: ExtendedCallToolRequest['params']['_meta'];
  sessionId?: string;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}): Promise<void> {
  const { server, taskId, args, tool, meta, sessionId, sendNotification } =
    params;

  return runWithRequestContext(
    {
      requestId: taskId,
      operationId: taskId,
      ...(sessionId ? { sessionId } : {}),
    },
    () =>
      runWithTraceContext(meta, async () => {
        const controller = attachAbortController(taskId);
        const progressState = { closed: false };

        try {
          updateTaskAndEmitStatus(server, taskId, {
            status: 'working',
            statusMessage: 'Task started',
          });
          logInfo(
            'Task execution started',
            { taskId, tool: tool.name },
            Loggers.LOG_TASKS
          );
          const relatedMeta = buildRelatedTaskMeta(taskId, meta);

          const result = await tool.execute(args, {
            signal: controller.signal,
            requestId: taskId,
            _meta: relatedMeta,
            progressState,
            canReportProgress: () =>
              taskManager.getTask(taskId)?.status === 'working',
            ...compact({ sendNotification }),
            onProgress: (progress, message, total) => {
              const current = taskManager.getTask(taskId);
              if (
                current?.status === 'working' &&
                (current.statusMessage !== message ||
                  current.progress !== progress ||
                  (total !== undefined && current.total !== total))
              ) {
                updateTaskAndEmitStatus(server, taskId, {
                  statusMessage: message,
                  progress,
                  ...(total !== undefined ? { total } : {}),
                });
              }
            },
          });

          const completionUpdate = buildTaskCompletionUpdate(result, tool);
          updateTaskAndEmitStatus(server, taskId, completionUpdate);
          if (completionUpdate.status === 'completed') {
            logInfo(
              'Task execution completed',
              { taskId, tool: tool.name },
              Loggers.LOG_TASKS
            );
          } else {
            logWarn(
              'Task execution completed with tool error result',
              { taskId, tool: tool.name },
              Loggers.LOG_TASKS
            );
          }
        } catch (error: unknown) {
          logError(
            'Task execution failed',
            {
              taskId,
              tool: tool.name,
              error: getErrorMessage(error),
            },
            Loggers.LOG_TASKS
          );
          updateTaskAndEmitStatus(server, taskId, buildTaskFailureState(error));
        } finally {
          progressState.closed = true;
          detachAbortController(taskId);
        }
      })
  );
}

function extractRawUrl(args: Record<string, unknown> | undefined): string {
  const url = args?.['url'];
  return typeof url === 'string' ? url : 'unknown';
}

function tryParseArguments(
  tool: TaskCapableToolDescriptor,
  args: Record<string, unknown> | undefined
): { ok: true; value: unknown } | { ok: false; response: ServerResult } {
  try {
    return { ok: true, value: tool.parseArguments(args) };
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return {
        ok: false,
        response: handleToolError(error, extractRawUrl(args)),
      };
    }
    throw error;
  }
}

function validateTaskSupport(
  server: McpServer,
  toolName: string,
  isTaskMode: boolean
): void {
  const support = getTaskCapableToolSupport(server, toolName);
  if (isTaskMode && support === 'forbidden') {
    throw createProtocolError(
      ProtocolErrorCode.MethodNotFound,
      `Task mode is not supported for tool: ${toolName}`
    );
  }
  if (!isTaskMode && support === 'required') {
    throw createProtocolError(
      ProtocolErrorCode.MethodNotFound,
      `Task mode is required for tool: ${toolName}`
    );
  }
}

function enqueueTaskToolExecution(
  server: McpServer,
  tool: NonNullable<ReturnType<typeof getTaskCapableTool>>,
  params: ExtendedCallToolRequest['params'],
  taskMeta: TaskMeta,
  context: ToolCallContext,
  parsedArgs: unknown
): ServerResult {
  const task = taskManager.createTask(
    {
      taskId: taskMeta.taskId,
      ...(taskMeta.keepAlive !== undefined
        ? { keepAlive: taskMeta.keepAlive }
        : {}),
    },
    'Task submitted',
    context.ownerKey
  );

  emitTaskCreatedNotification(server, task);

  logInfo(
    'Task execution queued',
    {
      taskId: task.taskId,
      tool: params.name,
      ...(taskMeta.keepAlive !== undefined
        ? { keepAlive: taskMeta.keepAlive }
        : {}),
    },
    Loggers.LOG_TASKS
  );

  void runTaskToolExecution({
    server,
    taskId: task.taskId,
    args: parsedArgs,
    tool,
    ...compact({
      meta: params._meta,
      sessionId: context.sessionId,
      sendNotification: context.sendNotification,
    }),
  });

  return {
    task: toTaskSummary(task),
    ...(tool.immediateResponse
      ? {
          _meta: {
            'io.modelcontextprotocol/model-immediate-response':
              tool.immediateResponse,
          },
        }
      : {}),
  };
}

export async function handleToolCallRequest(
  server: McpServer,
  request: ExtendedCallToolRequest,
  context: ToolCallContext
): Promise<ServerResult> {
  const { params } = request;

  return runWithTraceContext(params._meta, async () => {
    // Validate the tool name first so an unknown tool always produces MethodNotFound
    const tool = getTaskCapableTool(server, params.name);
    if (!tool) {
      throw createProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Unknown tool: ${params.name}`
      );
    }

    const taskMeta = getTaskMeta(params);
    validateTaskSupport(server, params.name, !!taskMeta);

    const parsed = tryParseArguments(tool, params.arguments);
    if (!parsed.ok) return parsed.response;

    if (taskMeta) {
      return enqueueTaskToolExecution(
        server,
        tool,
        params,
        taskMeta,
        context,
        parsed.value
      );
    }

    const progressState = { closed: false };
    logDebug(
      'Executing task-capable tool inline',
      {
        tool: params.name,
        hasProgressToken: params._meta?.progressToken !== undefined,
      },
      Loggers.LOG_TASKS
    );

    try {
      return await tool.execute(parsed.value, {
        ...buildToolHandlerExtra(context, params._meta),
        progressState,
      });
    } finally {
      progressState.closed = true;
    }
  });
}

/* -------------------------------------------------------------------------------------------------
 * Task handler schemas and registration
 * ------------------------------------------------------------------------------------------------- */

const TaskGetSchema = z.looseObject(
  {
    method: z.literal('tasks/get', 'Expected "tasks/get"'),
    params: z.looseObject(
      { taskId: z.string('Expected string') },
      'Expected object'
    ),
  },
  'Invalid request'
);
const TaskListSchema = z.looseObject(
  {
    method: z.literal('tasks/list', 'Expected "tasks/list"'),
    params: z
      .looseObject(
        {
          cursor: z.string('Expected string').optional(),
        },
        'Expected object'
      )
      .optional(),
  },
  'Invalid request'
);
const TaskCancelSchema = z.looseObject(
  {
    method: z.literal('tasks/cancel', 'Expected "tasks/cancel"'),
    params: z.looseObject(
      { taskId: z.string('Expected string') },
      'Expected object'
    ),
  },
  'Invalid request'
);
const TaskDeleteSchema = z.looseObject(
  {
    method: z.literal('tasks/delete', 'Expected "tasks/delete"'),
    params: z.looseObject(
      { taskId: z.string('Expected string') },
      'Expected object'
    ),
  },
  'Invalid request'
);
const TaskResultSchema = z.looseObject(
  {
    method: z.literal('tasks/result', 'Expected "tasks/result"'),
    params: z.looseObject(
      { taskId: z.string('Expected string') },
      'Expected object'
    ),
  },
  'Invalid request'
);
function resolveOwnerScopedExtra(extra: unknown): {
  parsedExtra: ReturnType<typeof parseHandlerExtra>;
  ownerKey: string;
} {
  const parsedExtra = parseHandlerExtra(extra);
  return {
    parsedExtra,
    ownerKey: resolveTaskOwnerKey(parsedExtra),
  };
}
interface TaskHandlerRegistrationOptions {
  requireInterception?: boolean;
}

interface TaskHandlerRegistrationResult {
  interceptedToolsCall: boolean;
  taskCapableToolsRegistered: boolean;
}

function throwStoredTaskError(task: {
  taskId: string;
  statusMessage?: string;
  error?: { code: number; message: string; data?: unknown };
}): never {
  if (task.error) {
    throw createProtocolError(
      task.error.code,
      task.error.message,
      task.error.data
    );
  }

  throw createProtocolError(
    ProtocolErrorCode.InternalError,
    task.statusMessage ?? 'Execution failed',
    { taskId: task.taskId }
  );
}

export function registerTaskHandlers(
  server: McpServer,
  options?: TaskHandlerRegistrationOptions
): TaskHandlerRegistrationResult {
  type RawRequestHandler = (request: unknown, ctx: ServerContext) => unknown;

  const setRawRequestHandler = server.server.setRequestHandler.bind(
    server.server
  ) as unknown as (method: string, handler: RawRequestHandler) => void;
  const registerRawHandler = Reflect.get(server.server, 'registerHandler') as
    | ((method: string, handler: RawRequestHandler) => void)
    | undefined;
  const registerCustomRequestHandler = registerRawHandler?.bind(
    server.server
  ) as ((method: string, handler: RawRequestHandler) => void) | undefined;
  const privateRequestHandlers = Reflect.get(
    server.server,
    '_requestHandlers'
  ) as Map<string, unknown> | undefined;
  const sdkCallToolHandler = getSdkCallToolHandler(server);
  const taskCapableToolsRegistered = hasRegisteredTaskCapableTools(server);
  const requireInterception = options?.requireInterception ?? true;

  if (!sdkCallToolHandler) {
    if (taskCapableToolsRegistered && requireInterception) {
      throw Error(
        'Task-capable tools are registered but SDK tools/call interception is unavailable. Upgrade compatibility or disable strict interception with TASKS_REQUIRE_INTERCEPTION=false.'
      );
    }

    logWarn(
      'Task call interception disabled: SDK tools/call handler unavailable; task-capable tools require MCP SDK compatibility update',
      { sdkVersion: 'unknown' },
      Loggers.LOG_TASKS
    );
  }

  if (sdkCallToolHandler) {
    setRawRequestHandler('tools/call', async (request, extra) => {
      const parsedExtra = parseHandlerExtra(extra);
      const requestId =
        parsedExtra?.requestId !== undefined
          ? String(parsedExtra.requestId)
          : randomUUID();

      return runWithRequestContext(
        {
          requestId,
          operationId: requestId,
          ...(parsedExtra?.sessionId
            ? { sessionId: parsedExtra.sessionId }
            : {}),
        },
        () => {
          const toolName =
            isObject(request) &&
            isObject(request['params']) &&
            typeof request['params']['name'] === 'string'
              ? request['params']['name']
              : '';

          // Only intercept task-capable tools managed by the local task registry.
          // Delegate all other tools to the SDK handler to avoid shadowing future tools.
          if (!hasTaskCapableTool(server, toolName)) {
            return sdkCallToolHandler(request, extra) as Promise<ServerResult>;
          }

          const parsed = parseExtendedCallToolRequest(request);
          const context = resolveToolCallContext(
            parsedExtra,
            parsed.params._meta
          );
          logDebug(
            'Intercepted task-capable tool call',
            {
              tool: toolName,
              taskRequested: getTaskMeta(parsed.params) !== undefined,
              hasProgressToken:
                parsed.params._meta?.progressToken !== undefined,
            },
            Loggers.LOG_TASKS
          );
          return handleToolCallRequest(server, parsed, context);
        }
      );
    });
  }

  setRawRequestHandler('tasks/get', (request, extra) => {
    const parsedRequest = TaskGetSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/get requested', { taskId }, Loggers.LOG_TASKS);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId);
  });

  setRawRequestHandler('tasks/result', (request, extra) => {
    const parsedRequest = TaskResultSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/result requested', { taskId }, Loggers.LOG_TASKS);

    const task = taskManager.getTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();
    if (task.status === 'submitted' || task.status === 'working') {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Task result is not available until the task completes',
        { taskId, status: task.status }
      );
    }
    if (task.status === 'input_required') {
      throw createProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Task result is not available while the task is waiting for input',
        { taskId, status: task.status }
      );
    }

    try {
      if (task.status === 'cancelled') {
        throwStoredTaskError(task);
      }

      if (task.status === 'failed') {
        throwStoredTaskError(task);
      }

      const result: ServerResult = isServerResult(task.result)
        ? task.result
        : { content: [] };

      return withRelatedTaskMeta(result, task.taskId);
    } finally {
      // Shrink keepAlive only after the result has been fully constructed
      // and is about to be delivered — avoids premature expiry if result
      // construction throws.
      taskManager.shrinkKeepAliveAfterDelivery(taskId);
    }
  });

  setRawRequestHandler('tasks/list', (request, extra) => {
    const parsedRequest = TaskListSchema.parse(request);
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const cursor = parsedRequest.params?.cursor;
    logDebug(
      'tasks/list requested',
      { hasCursor: cursor !== undefined },
      Loggers.LOG_TASKS
    );

    const { tasks, nextCursor } = taskManager.listTasks(
      cursor === undefined ? { ownerKey } : { ownerKey, cursor }
    );

    return {
      tasks: tasks.map((task) =>
        withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId)
      ),
      nextCursor,
    };
  });

  setRawRequestHandler('tasks/cancel', (request, extra) => {
    const parsedRequest = TaskCancelSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/cancel requested', { taskId }, Loggers.LOG_TASKS);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();

    abortTaskExecution(taskId);

    emitTaskStatusNotification(server, task);

    return withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId);
  });

  const tasksDeleteHandler = (
    request: unknown,
    extra: unknown
  ): Record<string, never> => {
    const parsedRequest = TaskDeleteSchema.parse(request);
    const { taskId } = parsedRequest.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/delete requested', { taskId }, Loggers.LOG_TASKS);

    const deleted = taskManager.deleteTask(taskId, ownerKey);
    if (!deleted) throwTaskNotFound();

    return {};
  };

  if (registerCustomRequestHandler) {
    registerCustomRequestHandler('tasks/delete', tasksDeleteHandler);
  } else if (privateRequestHandlers instanceof Map) {
    privateRequestHandlers.set('tasks/delete', tasksDeleteHandler);
  } else {
    throw Error(
      'Custom request handler registration is unavailable; tasks/delete cannot be registered.'
    );
  }

  return {
    interceptedToolsCall: sdkCallToolHandler !== null,
    taskCapableToolsRegistered,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Handler extra parsing & owner-key resolution
 * ------------------------------------------------------------------------------------------------- */

interface HandlerExtra {
  sessionId?: string;
  authInfo?: { clientId?: string; token?: string };
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  _meta?: ToolCallRequestMeta;
}

export interface ToolExecutionContext {
  ownerKey: string;
  sessionId?: string;
  signal?: AbortSignal;
  requestId?: string | number;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  requestMeta?: ToolCallRequestMeta;
}

export type ToolCallContext = ToolExecutionContext;

interface AuthIdentity {
  clientId?: string;
  token?: string;
}

/** Strip keys whose value is `undefined`, returning an object with only the
 * present keys. Return type correctly omits the `undefined` union so the result
 * is compatible with `exactOptionalPropertyTypes`. */
type Compacted<T extends object> = {
  [K in keyof T as Exclude<T[K], undefined> extends never
    ? never
    : K]?: Exclude<T[K], undefined>;
};

export function compact<T extends object>(obj: T): Compacted<T> {
  const result: Compacted<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      (result as Record<string, unknown>)[key as string] = obj[key];
    }
  }
  return result;
}

function normalizeSendNotification(
  sendNotification: unknown
): ((notification: ProgressNotification) => Promise<void>) | undefined {
  if (typeof sendNotification !== 'function') return undefined;
  const notify = sendNotification as (
    notification: ProgressNotification
  ) => Promise<void> | void;
  return async (notification: ProgressNotification): Promise<void> => {
    await Promise.resolve(notify(notification));
  };
}

function normalizeAuthInfo(
  authInfo: unknown
): NonNullable<HandlerExtra['authInfo']> | undefined {
  if (!isObject(authInfo)) return undefined;

  const { clientId, token } = authInfo;
  const normalized: NonNullable<HandlerExtra['authInfo']> = {};
  if (typeof clientId === 'string') normalized.clientId = clientId;
  if (typeof token === 'string') normalized.token = token;

  return normalized.clientId || normalized.token ? normalized : undefined;
}

export function parseHandlerExtra(extra: unknown): HandlerExtra | undefined {
  if (!isObject(extra)) return undefined;
  const ctx = extra as Partial<ServerContext>;

  const parsed: HandlerExtra = {};
  const authInfo = ctx.http?.authInfo;
  const signal = ctx.mcpReq?.signal;
  const requestId = ctx.mcpReq?.id;
  const sendNotification = ctx.mcpReq?.notify;
  const sessionId = resolveSessionIdFromExtra(ctx);
  if (sessionId) parsed.sessionId = sessionId;

  const normalizedAuthInfo = normalizeAuthInfo(authInfo);
  if (normalizedAuthInfo) {
    parsed.authInfo = normalizedAuthInfo;
  }

  if (signal instanceof AbortSignal) parsed.signal = signal;

  if (typeof requestId === 'string' || typeof requestId === 'number') {
    parsed.requestId = requestId;
  }

  const normalizedSendNotification =
    normalizeSendNotification(sendNotification);
  if (normalizedSendNotification) {
    parsed.sendNotification = normalizedSendNotification;
  }

  if (isObject(ctx.mcpReq?._meta)) {
    parsed._meta = ctx.mcpReq._meta as ToolCallRequestMeta;
  }

  return parsed;
}

export function buildAuthenticatedOwnerKey(
  authInfo?: AuthIdentity
): string | undefined {
  const authClientId =
    typeof authInfo?.clientId === 'string' ? authInfo.clientId : '';
  const authToken = typeof authInfo?.token === 'string' ? authInfo.token : '';

  if (authClientId || authToken) {
    const hashInput = `${authClientId}:${authToken}`;
    return `auth:${hash('sha256', hashInput, 'hex')}`;
  }

  return undefined;
}

export function resolveTaskOwnerKey(extra?: HandlerExtra): string {
  const authenticatedOwnerKey = buildAuthenticatedOwnerKey(extra?.authInfo);
  if (authenticatedOwnerKey) return authenticatedOwnerKey;

  if (extra?.sessionId) {
    return (
      resolveMcpSessionOwnerKey(extra.sessionId) ?? `session:${extra.sessionId}`
    );
  }

  return 'default';
}

function resolveRequestIdFromExtra(extra: unknown): string | undefined {
  const parsedExtra = parseHandlerExtra(extra);
  if (!parsedExtra) return undefined;

  const { requestId } = parsedExtra;
  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);

  return undefined;
}

function getHeaderString(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value ?? undefined;
}

function resolveSessionIdFromExtra(
  extra: Partial<ServerContext> | undefined
): string | undefined {
  const { sessionId } = extra ?? {};
  if (typeof sessionId === 'string') return sessionId;

  const headers = extra?.http?.req?.headers;
  if (!(headers instanceof Headers)) return undefined;

  return (
    getHeaderString(headers, 'mcp-session-id') ??
    getHeaderString(headers, 'x-mcp-session-id')
  );
}

function resolveToolExecutionContext(
  extra?: HandlerExtra,
  requestMeta?: ToolCallRequestMeta
): ToolExecutionContext {
  return compact({
    ownerKey: resolveTaskOwnerKey(extra),
    sessionId: extra?.sessionId,
    signal: extra?.signal,
    requestId: extra?.requestId,
    sendNotification: extra?.sendNotification,
    requestMeta: sanitizeToolCallMeta(requestMeta),
  }) as ToolExecutionContext;
}

export function resolveToolCallContext(
  extra?: HandlerExtra,
  requestMeta?: ToolCallRequestMeta
): ToolCallContext {
  return resolveToolExecutionContext(extra, requestMeta);
}

export function buildToolHandlerExtra(
  context: ToolExecutionContext,
  requestMeta?: ToolCallRequestMeta
): ToolHandlerExtra {
  return compact({
    signal: context.signal,
    requestId: context.requestId,
    sendNotification: context.sendNotification,
    _meta: sanitizeToolCallMeta(requestMeta ?? context.requestMeta),
  }) as ToolHandlerExtra;
}

export function withRequestContextIfMissing<TParams, TResult, TExtra = unknown>(
  handler: (params: TParams, extra?: TExtra) => Promise<TResult>
): (params: TParams, extra?: TExtra) => Promise<TResult> {
  return async (params, extra) => {
    const existingRequestId = getRequestId();
    if (existingRequestId) {
      const traceMeta = parseHandlerExtra(extra)?._meta;
      return runWithTraceContext(traceMeta, () => handler(params, extra));
    }

    const derivedRequestId = resolveRequestIdFromExtra(extra) ?? randomUUID();
    const derivedSessionId = resolveSessionIdFromExtra(
      extra as Partial<ServerContext> | undefined
    );

    const traceMeta = parseHandlerExtra(extra)?._meta;

    return runWithRequestContext(
      {
        requestId: derivedRequestId,
        operationId: derivedRequestId,
        ...(derivedSessionId ? { sessionId: derivedSessionId } : {}),
      },
      () => runWithTraceContext(traceMeta, () => handler(params, extra))
    );
  };
}

export function isServerResult(value: unknown): value is ServerResult {
  return isObject(value) && Array.isArray(value['content']);
}

export type TaskCapableToolSupport = 'required' | 'optional' | 'forbidden';

export interface TaskCapableToolDescriptor<TArgs = unknown> {
  name: string;
  parseArguments: (args: unknown) => TArgs;
  execute: (args: TArgs, extra?: ToolHandlerExtra) => Promise<ServerResult>;
  getCompletionStatusMessage?: (result: ServerResult) => string | undefined;
  taskSupport?: TaskCapableToolSupport;
  immediateResponse?: string;
}

const taskCapableToolsByServer = new WeakMap<
  McpServer,
  Map<string, TaskCapableToolDescriptor>
>();

function getServerToolMap(
  server: McpServer
): Map<string, TaskCapableToolDescriptor> {
  let toolMap = taskCapableToolsByServer.get(server);
  if (toolMap) return toolMap;

  toolMap = new Map<string, TaskCapableToolDescriptor>();
  taskCapableToolsByServer.set(server, toolMap);
  registerServerLifecycleCleanup(server, () => {
    taskCapableToolsByServer.delete(server);
  });
  return toolMap;
}

export function registerTaskCapableTool<TArgs>(
  server: McpServer,
  descriptor: TaskCapableToolDescriptor<TArgs>
): void {
  getServerToolMap(server).set(descriptor.name, {
    ...descriptor,
    taskSupport: descriptor.taskSupport ?? 'optional',
  } as TaskCapableToolDescriptor);
}

export function unregisterTaskCapableTool(
  server: McpServer,
  name: string
): void {
  getServerToolMap(server).delete(name);
}

export function getTaskCapableTool(
  server: McpServer,
  name: string
): TaskCapableToolDescriptor | undefined {
  return getServerToolMap(server).get(name);
}

export function getTaskCapableToolSupport(
  server: McpServer,
  name: string
): TaskCapableToolSupport | undefined {
  return getServerToolMap(server).get(name)?.taskSupport;
}

export function hasTaskCapableTool(server: McpServer, name: string): boolean {
  return getServerToolMap(server).has(name);
}

export function hasRegisteredTaskCapableTools(server: McpServer): boolean {
  return getServerToolMap(server).size > 0;
}

export function setTaskCapableToolSupport(
  server: McpServer,
  name: string,
  support: TaskCapableToolSupport
): void {
  const descriptor = getServerToolMap(server).get(name);
  if (!descriptor) return;
  descriptor.taskSupport = support;
}
