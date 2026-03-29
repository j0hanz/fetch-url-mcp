import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, hash, randomBytes, randomUUID } from 'node:crypto';
import { setInterval } from 'node:timers';

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
  stripMcpErrorPrefix,
  toError,
  tryReadToolErrorMessage,
} from '../lib/error/index.js';
import {
  createMcpError,
  getSdkCallToolHandler,
  type ProgressNotification,
  registerServerLifecycleCleanup,
  type ToolHandlerExtra,
} from '../lib/mcp-interop.js';
import {
  type CancellableTimeout,
  createUnrefTimeout,
  formatZodError,
  isObject,
  timingSafeEqualUtf8,
} from '../lib/utils.js';

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

export const extendedCallToolRequestSchema = z.looseObject({
  method: z.literal('tools/call'),
  params: z.strictObject({
    name: z.string().min(1, 'Tool name required'),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: toolCallMetaSchema.optional(),
  }),
});

export type ExtendedCallToolRequest = z.infer<
  typeof extendedCallToolRequestSchema
>;
export type ToolCallRequestMeta = ExtendedCallToolRequest['params']['_meta'];
type TaskMeta = NonNullable<
  NonNullable<ToolCallRequestMeta>['modelcontextprotocol.io/task']
>;

function getTaskMeta(
  params: ExtendedCallToolRequest['params']
): TaskMeta | undefined {
  return params._meta?.['modelcontextprotocol.io/task'];
}

export function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = extendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;

  throw createMcpError(ErrorCode.InvalidParams, formatZodError(parsed.error));
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
  throw createMcpError(ErrorCode.InvalidParams, 'Task not found');
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
    error instanceof McpError ? stripMcpErrorPrefix(error.message) : undefined;
  const statusMessage = mcpErrorMessage ?? getErrorMessage(error);

  if (error instanceof McpError) {
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
      code: ErrorCode.InternalError,
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
            code: ErrorCode.InternalError,
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
    if (error instanceof McpError) {
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
    throw createMcpError(
      ErrorCode.MethodNotFound,
      `Task mode is not supported for tool: ${toolName}`
    );
  }
  if (!isTaskMode && support === 'required') {
    throw createMcpError(
      ErrorCode.MethodNotFound,
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
      throw createMcpError(
        ErrorCode.MethodNotFound,
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
    throw createMcpError(task.error.code, task.error.message, task.error.data);
  }

  throw createMcpError(
    ErrorCode.InternalError,
    task.statusMessage ?? 'Execution failed',
    { taskId: task.taskId }
  );
}

export function registerTaskHandlers(
  server: McpServer,
  options?: TaskHandlerRegistrationOptions
): TaskHandlerRegistrationResult {
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
    server.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
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
            const toolName = request.params.name;

            // Only intercept task-capable tools managed by the local task registry.
            // Delegate all other tools to the SDK handler to avoid shadowing future tools.
            if (!hasTaskCapableTool(server, toolName)) {
              return sdkCallToolHandler(
                request,
                extra
              ) as Promise<ServerResult>;
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
      }
    );
  }

  server.server.setRequestHandler(TaskGetSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/get requested', { taskId }, Loggers.LOG_TASKS);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId);
  });

  server.server.setRequestHandler(TaskResultSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/result requested', { taskId }, Loggers.LOG_TASKS);

    const task = taskManager.getTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();
    if (task.status === 'submitted' || task.status === 'working') {
      throw createMcpError(
        ErrorCode.InvalidParams,
        'Task result is not available until the task completes',
        { taskId, status: task.status }
      );
    }
    if (task.status === 'input_required') {
      throw createMcpError(
        ErrorCode.InvalidParams,
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

  server.server.setRequestHandler(TaskListSchema, (request, extra) => {
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const cursor = request.params?.cursor;
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

  server.server.setRequestHandler(TaskCancelSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/cancel requested', { taskId }, Loggers.LOG_TASKS);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();

    abortTaskExecution(taskId);

    emitTaskStatusNotification(server, task);

    return withRelatedTaskSummaryMeta(toTaskSummary(task), task.taskId);
  });

  server.server.setRequestHandler(TaskDeleteSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/delete requested', { taskId }, Loggers.LOG_TASKS);

    const deleted = taskManager.deleteTask(taskId, ownerKey);
    if (!deleted) throwTaskNotFound();

    return {};
  });

  return {
    interceptedToolsCall: sdkCallToolHandler !== null,
    taskCapableToolsRegistered,
  };
}

export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

export interface TaskState {
  taskId: string;
  ownerKey: string;
  status: TaskStatus;
  statusMessage?: string;
  progress?: number;
  total?: number;
  createdAt: string;
  lastUpdatedAt: string;
  keepAlive: number; // in ms
  pollFrequency: number; // in ms
  result?: unknown;
  error?: TaskError;
}

interface InternalTaskState extends TaskState {
  _createdAtMs: number;
  _terminalAtMs?: number;
}

interface CreateTaskOptions {
  taskId?: string;
  keepAlive?: number;
}

export interface CreateTaskResult {
  [key: string]: unknown;
  task: {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    progress?: number;
    total?: number;
    createdAt: string;
    lastUpdatedAt: string;
    keepAlive: number;
    pollFrequency: number;
  };
}

const DEFAULT_KEEP_ALIVE_MS = 60_000;
const MIN_KEEP_ALIVE_MS = 1_000;
const MAX_KEEP_ALIVE_MS = 86_400_000;
const DEFAULT_POLL_FREQUENCY_MS = 1_000;
const DEFAULT_OWNER_KEY = 'default';
const DEFAULT_PAGE_SIZE = 50;

const CLEANUP_INTERVAL_MS = 60_000;
const RESULT_DELIVERY_GRACE_MS = 10_000;
const TASK_STATUS_VALUES = new Set<TaskStatus>([
  'submitted',
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function resolveNextTaskStatus(
  task: TaskState,
  updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
): TaskStatus {
  const nextStatus = updates.status;
  if (!nextStatus || nextStatus === task.status) return task.status;

  if (!TASK_STATUS_VALUES.has(nextStatus)) {
    throw createMcpError(
      ErrorCode.InternalError,
      `Invalid task status: ${nextStatus}`
    );
  }

  if (isTerminalStatus(task.status)) {
    throw createMcpError(
      ErrorCode.InternalError,
      `Cannot transition task from ${task.status} to ${nextStatus}`
    );
  }

  return nextStatus;
}

function normalizeKeepAlive(keepAlive: number | undefined): number {
  if (keepAlive === undefined || !Number.isFinite(keepAlive))
    return DEFAULT_KEEP_ALIVE_MS;
  return Math.max(
    MIN_KEEP_ALIVE_MS,
    Math.min(Math.trunc(keepAlive), MAX_KEEP_ALIVE_MS)
  );
}

function logTaskStatusTransition(
  task: TaskState,
  previousStatus: TaskStatus,
  nextStatus: TaskStatus
): void {
  if (previousStatus === nextStatus) return;

  const meta = {
    taskId: task.taskId,
    ownerKey: task.ownerKey,
    previousStatus,
    nextStatus,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
  };

  if (nextStatus === 'failed') {
    logWarn('Task status changed to failed', meta, Loggers.LOG_TASKS);
    return;
  }

  logInfo('Task status changed', meta, Loggers.LOG_TASKS);
}

class TaskManager {
  private tasks = new Map<string, InternalTaskState>();
  private ownerCounts = new Map<string, number>();
  private readonly waiters = new TaskWaiterRegistry<InternalTaskState>(
    isTerminalStatus
  );
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private ensureCleanupLoop(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.removeExpiredTasks();
      if (this.tasks.size === 0) this.stopCleanupLoop();
    }, CLEANUP_INTERVAL_MS).unref();
  }

  private stopCleanupLoop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private isTaskExpired(task: InternalTaskState, nowMs: number): boolean {
    if (task._terminalAtMs !== undefined) {
      return nowMs - task._terminalAtMs > task.keepAlive;
    }
    return nowMs - task._createdAtMs > MAX_KEEP_ALIVE_MS;
  }

  private removeExpiredTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (this.isTaskExpired(task, now)) {
        logWarn(
          'Task expired',
          {
            taskId: task.taskId,
            ownerKey: task.ownerKey,
            status: task.status,
          },
          Loggers.LOG_TASKS
        );
        this.removeTask(task.taskId);
      }
    }
  }

  private removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (!isTerminalStatus(task.status)) {
      this.applyTaskUpdate(task, {
        status: 'failed',
        statusMessage: 'Task removed due to expiration',
      });
      this.waiters.notify(task);
    }

    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
  }

  private applyTaskUpdate(
    task: InternalTaskState,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    Object.assign(task, updates);
    task.lastUpdatedAt = new Date().toISOString();
    if (
      updates.status &&
      isTerminalStatus(updates.status) &&
      task._terminalAtMs === undefined
    ) {
      task._terminalAtMs = Date.now();
    }
  }

  private cancelActiveTask(
    task: InternalTaskState,
    statusMessage: string
  ): void {
    this.applyTaskUpdate(task, {
      status: 'cancelled',
      statusMessage,
      error: {
        code: ErrorCode.ConnectionClosed,
        message: statusMessage,
        data: { code: 'ABORTED' },
      },
    });
    this.waiters.notify(task);
  }

  private releaseTaskCapacity(task: InternalTaskState | TaskState): void {
    const { ownerKey } = task;
    const nextCount = (this.ownerCounts.get(ownerKey) ?? 0) - 1;
    if (nextCount > 0) {
      this.ownerCounts.set(ownerKey, nextCount);
    } else {
      this.ownerCounts.delete(ownerKey);
    }
  }

  private reserveTaskCapacity(ownerKey: string): void {
    const { maxPerOwner, maxTotal } = config.tasks;

    if (this.tasks.size >= maxTotal) {
      throw createMcpError(
        ErrorCode.InvalidRequest,
        `Server task limit reached (${maxTotal})`
      );
    }

    if ((this.ownerCounts.get(ownerKey) ?? 0) >= maxPerOwner) {
      throw createMcpError(
        ErrorCode.InvalidRequest,
        `Task limit reached for this session (${maxPerOwner})`
      );
    }

    this.ownerCounts.set(ownerKey, (this.ownerCounts.get(ownerKey) ?? 0) + 1);
  }

  createTask(
    options?: CreateTaskOptions,
    statusMessage = 'Task submitted',
    ownerKey: string = DEFAULT_OWNER_KEY
  ): TaskState {
    this.removeExpiredTasks();

    const taskId = options?.taskId ?? randomUUID();
    if (this.tasks.has(taskId)) {
      throw createMcpError(
        ErrorCode.InvalidRequest,
        `Task already exists: ${taskId}`
      );
    }

    this.reserveTaskCapacity(ownerKey);

    const now = new Date();
    const createdAt = now.toISOString();

    const task: InternalTaskState = {
      taskId,
      ownerKey,
      status: 'submitted',
      statusMessage,
      createdAt,
      lastUpdatedAt: createdAt,
      keepAlive: normalizeKeepAlive(options?.keepAlive),
      pollFrequency: DEFAULT_POLL_FREQUENCY_MS,
      _createdAtMs: now.getTime(),
    };

    this.tasks.set(task.taskId, task);
    this.ensureCleanupLoop();
    logInfo(
      'Task created',
      {
        taskId: task.taskId,
        ownerKey,
        keepAlive: task.keepAlive,
      },
      Loggers.LOG_TASKS
    );
    return task;
  }

  private lookupActiveTask(
    taskId: string,
    ownerKey?: string
  ): InternalTaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (ownerKey && task.ownerKey !== ownerKey) return undefined;

    if (this.isTaskExpired(task, Date.now())) {
      this.removeTask(taskId);
      return undefined;
    }

    return task;
  }

  getTask(taskId: string, ownerKey?: string): TaskState | undefined {
    return this.lookupActiveTask(taskId, ownerKey);
  }

  updateTask(
    taskId: string,
    updates: Partial<Omit<TaskState, 'taskId' | 'createdAt'>>
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      logWarn(
        'updateTask called for unknown task',
        { taskId },
        Loggers.LOG_TASKS
      );
      return;
    }
    if (isTerminalStatus(task.status)) {
      logWarn(
        'updateTask called for terminal task',
        {
          taskId,
          currentStatus: task.status,
        },
        Loggers.LOG_TASKS
      );
      return;
    }

    const nextStatus = resolveNextTaskStatus(task, updates);
    const previousStatus = task.status;

    this.applyTaskUpdate(task, {
      ...updates,
      ...(updates.status === undefined ? {} : { status: nextStatus }),
    });

    logTaskStatusTransition(task, previousStatus, task.status);

    this.waiters.notify(task);
  }

  cancelTask(taskId: string, ownerKey?: string): TaskState | undefined {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return undefined;

    if (isTerminalStatus(task.status)) {
      throw createMcpError(
        ErrorCode.InvalidParams,
        `Cannot cancel task: already ${task.status}`
      );
    }

    this.cancelActiveTask(task, 'The task was cancelled by request.');
    logInfo(
      'Task cancelled by request',
      {
        taskId: task.taskId,
        ownerKey: task.ownerKey,
      },
      Loggers.LOG_TASKS
    );
    return task;
  }

  deleteTask(taskId: string, ownerKey?: string): boolean {
    const task = this.lookupActiveTask(taskId, ownerKey);
    if (!task) return false;

    if (!isTerminalStatus(task.status)) {
      throw createMcpError(
        ErrorCode.InvalidParams,
        `Cannot delete task: status is ${task.status}`
      );
    }

    this.tasks.delete(taskId);
    this.releaseTaskCapacity(task);
    logInfo(
      'Task deleted by request',
      { taskId: task.taskId, ownerKey: task.ownerKey },
      Loggers.LOG_TASKS
    );
    return true;
  }

  cancelTasksByOwner(
    ownerKey: string,
    statusMessage = 'The task was cancelled because its owner is no longer active.'
  ): TaskState[] {
    if (!ownerKey) return [];

    const cancelled: TaskState[] = [];
    for (const task of this.tasks.values()) {
      if (task.ownerKey === ownerKey && !isTerminalStatus(task.status)) {
        this.cancelActiveTask(task, statusMessage);
        cancelled.push(task);
      }
    }
    if (cancelled.length > 0) {
      logInfo(
        'Tasks cancelled for owner',
        {
          ownerKey,
          count: cancelled.length,
        },
        Loggers.LOG_TASKS
      );
    }
    return cancelled;
  }

  private collectPage(
    ownerKey: string,
    anchorTaskId: string | null,
    pageSize: number
  ): TaskState[] {
    const now = Date.now();
    const validTasks = Array.from(this.tasks.values()).filter((task) => {
      if (task.ownerKey !== ownerKey) return false;
      if (this.isTaskExpired(task, now)) {
        this.removeTask(task.taskId);
        return false;
      }
      return true;
    });

    if (anchorTaskId === null) {
      return validTasks.slice(0, pageSize + 1);
    }

    const anchorIndex = validTasks.findIndex((t) => t.taskId === anchorTaskId);
    if (anchorIndex === -1) {
      throw createMcpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }

    return validTasks.slice(anchorIndex + 1, anchorIndex + 1 + pageSize + 1);
  }

  listTasks(options: { ownerKey: string; cursor?: string; limit?: number }): {
    tasks: TaskState[];
    nextCursor?: string;
  } {
    const limit =
      options.limit && options.limit > 0 ? options.limit : DEFAULT_PAGE_SIZE;
    const anchorTaskId = this.resolveAnchorTaskId(options.cursor);

    const page = this.collectPage(options.ownerKey, anchorTaskId, limit);
    const hasMore = page.length > limit;
    if (hasMore) page.pop();

    const lastTask = page.at(-1);
    const nextCursor =
      hasMore && lastTask ? encodeTaskCursor(lastTask.taskId) : undefined;

    return nextCursor ? { tasks: page, nextCursor } : { tasks: page };
  }

  private resolveAnchorTaskId(cursor?: string): string | null {
    if (!cursor) return null;
    const decoded = decodeTaskCursor(cursor);
    if (!decoded)
      throw createMcpError(ErrorCode.InvalidParams, 'Invalid cursor');
    return decoded.anchorTaskId;
  }

  async waitForTerminalTask(
    taskId: string,
    ownerKey: string,
    signal?: AbortSignal
  ): Promise<TaskState | undefined> {
    return waitForTerminalTask({
      taskId,
      ownerKey,
      ...(signal && { signal }),
      lookupTask: (id: string, owner: string) =>
        this.lookupActiveTask(id, owner),
      removeTask: (id: string) => {
        this.removeTask(id);
      },
      registry: this.waiters,
      isTerminalStatus,
    });
  }

  shrinkKeepAliveAfterDelivery(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || !isTerminalStatus(task.status)) return;

    if (RESULT_DELIVERY_GRACE_MS < task.keepAlive) {
      task.keepAlive = RESULT_DELIVERY_GRACE_MS;
      task.lastUpdatedAt = new Date().toISOString();
    }
  }
}

const MAX_CURSOR_LENGTH = 256;
const MAX_ANCHOR_ID_LENGTH = 128;
const CURSOR_SECRET = randomBytes(32);

function signPayload(payload: string): string {
  return createHmac('sha256', CURSOR_SECRET)
    .update(payload)
    .digest('base64url');
}

export function encodeTaskCursor(anchorTaskId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ anchorTaskId }),
    'utf8'
  ).toString('base64url');
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

function validateDecodedPayload(
  decoded: unknown
): { anchorTaskId: string } | null {
  if (!isObject(decoded)) return null;

  const { anchorTaskId } = decoded;
  if (
    typeof anchorTaskId !== 'string' ||
    anchorTaskId.length === 0 ||
    anchorTaskId.length > MAX_ANCHOR_ID_LENGTH
  ) {
    return null;
  }

  return { anchorTaskId };
}

export function decodeTaskCursor(
  cursor: string
): { anchorTaskId: string } | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) return null;

  const [payload, signature, ...rest] = cursor.split('.');
  if (!payload || !signature || rest.length > 0) return null;
  if (!timingSafeEqualUtf8(signPayload(payload), signature)) return null;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    return validateDecodedPayload(decoded);
  } catch {
    return null;
  }
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
  requestInfo?: unknown;
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

  const parsed: HandlerExtra = {};
  const { authInfo, signal, requestId, sendNotification } = extra;
  const sessionId = resolveSessionIdFromExtra(extra);
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
  if (!isObject(extra)) return undefined;

  const { requestId } = extra;
  if (typeof requestId === 'string') return requestId;
  if (typeof requestId === 'number') return String(requestId);

  return undefined;
}

function getHeaderString(
  headers: Record<PropertyKey, unknown>,
  name: string
): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;

  return value.find((entry): entry is string => typeof entry === 'string');
}

function resolveSessionIdFromExtra(extra: unknown): string | undefined {
  if (!isObject(extra)) return undefined;

  const { sessionId } = extra;
  if (typeof sessionId === 'string') return sessionId;

  const { requestInfo } = extra;
  if (!isObject(requestInfo)) return undefined;

  const { headers } = requestInfo;
  if (!isObject(headers)) return undefined;

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
      const traceMeta =
        isObject(extra) && isObject(extra['_meta'])
          ? extra['_meta']
          : undefined;
      return runWithTraceContext(traceMeta, () => handler(params, extra));
    }

    const derivedRequestId = resolveRequestIdFromExtra(extra) ?? randomUUID();
    const derivedSessionId = resolveSessionIdFromExtra(extra);

    const traceMeta =
      isObject(extra) && isObject(extra['_meta']) ? extra['_meta'] : undefined;

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

interface WaitableTask {
  taskId: string;
  ownerKey: string;
  status: string;
  keepAlive: number;
  _createdAtMs: number;
}

type TaskWaiter<TTask extends WaitableTask> = (task: TTask) => void;

export class TaskWaiterRegistry<TTask extends WaitableTask> {
  private waiters = new Map<string, Set<TaskWaiter<TTask>>>();

  constructor(
    private readonly isTerminalStatus: (status: TTask['status']) => boolean
  ) {}

  add(taskId: string, waiter: TaskWaiter<TTask>): void {
    let set = this.waiters.get(taskId);
    if (!set) {
      set = new Set();
      this.waiters.set(taskId, set);
    }
    set.add(waiter);
  }

  remove(taskId: string, waiter: TaskWaiter<TTask> | null): void {
    if (!waiter) return;

    const set = this.waiters.get(taskId);
    if (!set) return;

    set.delete(waiter);
    if (set.size === 0) {
      this.waiters.delete(taskId);
    }
  }

  notify(task: TTask): void {
    if (!this.isTerminalStatus(task.status)) return;

    const waiters = this.waiters.get(task.taskId);
    if (!waiters) return;

    this.waiters.delete(task.taskId);
    for (const waiter of waiters) waiter(task);
  }
}

export async function waitForTerminalTask<TTask extends WaitableTask>(options: {
  taskId: string;
  ownerKey: string;
  signal?: AbortSignal;
  lookupTask: (taskId: string, ownerKey: string) => TTask | undefined;
  removeTask: (taskId: string) => void;
  registry: TaskWaiterRegistry<TTask>;
  isTerminalStatus: (status: TTask['status']) => boolean;
}): Promise<TTask | undefined> {
  const task = options.lookupTask(options.taskId, options.ownerKey);
  if (!task) return undefined;

  if (options.isTerminalStatus(task.status)) return task;

  const deadlineMs = task._createdAtMs + task.keepAlive;

  const { promise, resolve, reject } = Promise.withResolvers<
    TTask | undefined
  >();
  const resolveInContext = AsyncLocalStorage.bind(
    (value: TTask | undefined): void => {
      resolve(value);
    }
  );
  const rejectInContext = AsyncLocalStorage.bind((error: unknown): void => {
    reject(toError(error));
  });

  let settled = false;
  let waiter: TaskWaiter<TTask> | null = null;
  let deadlineTimeout: CancellableTimeout<{ timeout: true }> | undefined;

  const cleanup = (): void => {
    if (deadlineTimeout) {
      deadlineTimeout.cancel();
      deadlineTimeout = undefined;
    }
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
  };

  const settleOnce = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };

  const onAbort = (): void => {
    settleOnce(() => {
      cleanup();
      options.registry.remove(options.taskId, waiter);
      rejectInContext(
        createMcpError(ErrorCode.ConnectionClosed, 'Request was cancelled')
      );
    });
  };

  waiter = (updated: TTask): void => {
    settleOnce(() => {
      cleanup();
      if (updated.ownerKey !== options.ownerKey) {
        resolveInContext(undefined);
        return;
      }
      resolveInContext(updated);
    });
  };

  if (options.signal?.aborted) {
    onAbort();
    return promise;
  }

  options.registry.add(options.taskId, waiter);

  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const timeoutMs = Math.max(0, deadlineMs - Date.now());

  deadlineTimeout = createUnrefTimeout(timeoutMs, { timeout: true });
  void deadlineTimeout.promise
    .then(() => {
      settleOnce(() => {
        cleanup();
        options.registry.remove(options.taskId, waiter);
        options.removeTask(options.taskId);
        rejectInContext(
          createMcpError(ErrorCode.InvalidParams, 'Task expired', {
            taskId: options.taskId,
          })
        );
      });
    })
    .catch(rejectInContext);

  return promise;
}

export const taskManager = new TaskManager();
