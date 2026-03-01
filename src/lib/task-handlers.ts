import { randomUUID } from 'node:crypto';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  abortTaskExecution,
  emitTaskStatusNotification,
  type ExtendedCallToolRequest,
  handleToolCallRequest,
  throwTaskNotFound,
  toTaskSummary,
  withRelatedTaskMeta,
} from '../tasks/execution.js';
import { taskManager } from '../tasks/manager.js';
import {
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
} from '../tasks/owner.js';
import { hasTaskCapableTool } from '../tasks/tool-registry.js';
import { logWarn, runWithRequestContext } from './core.js';

/* -------------------------------------------------------------------------------------------------
 * Server lifecycle cleanup hooks
 *
 * WARNING (S-3): This section monkey-patches `server.close` and `server.server.onclose`
 * to inject cleanup callbacks. This is fragile and may break if the MCP SDK
 * changes the close/shutdown lifecycle. Isolated here until the SDK exposes a
 * first-class lifecycle cleanup registration API. If the SDK adds native
 * onClose/onShutdown hooks, migrate to those and remove the patching.
 * ------------------------------------------------------------------------------------------------- */

type CleanupCallback = () => void;
const patchedCleanupServers = new WeakSet<McpServer>();
const serverCleanupCallbacks = new WeakMap<McpServer, Set<CleanupCallback>>();
function getServerCleanupCallbackSet(server: McpServer): Set<CleanupCallback> {
  let callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks) {
    callbacks = new Set<CleanupCallback>();
    serverCleanupCallbacks.set(server, callbacks);
  }
  return callbacks;
}
function drainServerCleanupCallbacks(server: McpServer): void {
  const callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks || callbacks.size === 0) return;

  const pending = [...callbacks];
  callbacks.clear();
  for (const callback of pending) {
    try {
      callback();
    } catch (error: unknown) {
      logWarn('Server cleanup callback failed', { error });
    }
  }
}
function ensureServerCleanupHooks(server: McpServer): void {
  if (patchedCleanupServers.has(server)) return;
  patchedCleanupServers.add(server);

  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    drainServerCleanupCallbacks(server);
    originalOnClose?.();
  };

  const originalClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    drainServerCleanupCallbacks(server);
    await originalClose();
  };
}
export function registerServerLifecycleCleanup(
  server: McpServer,
  callback: CleanupCallback
): void {
  ensureServerCleanupHooks(server);
  getServerCleanupCallbackSet(server).add(callback);
}

export {
  cancelTasksForOwner,
  abortAllTaskExecutions,
} from '../tasks/execution.js';

/* -------------------------------------------------------------------------------------------------
 * Task handler schemas and registration
 * ------------------------------------------------------------------------------------------------- */

const TaskGetSchema = z
  .object({
    method: z.literal('tasks/get'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const TaskListSchema = z
  .object({
    method: z.literal('tasks/list'),
    params: z
      .object({
        cursor: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const TaskCancelSchema = z
  .object({
    method: z.literal('tasks/cancel'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const TaskResultSchema = z
  .object({
    method: z.literal('tasks/result'),
    params: z.object({ taskId: z.string() }).loose(),
  })
  .loose();
const MIN_TASK_TTL_MS = 1_000;
const MAX_TASK_TTL_MS = 86_400_000;
const ExtendedCallToolRequestSchema: z.ZodType<ExtendedCallToolRequest> = z
  .object({
    method: z.literal('tools/call'),
    params: z
      .object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
        task: z
          .strictObject({
            ttl: z
              .number()
              .int()
              .min(MIN_TASK_TTL_MS)
              .max(MAX_TASK_TTL_MS)
              .optional(),
          })
          .optional(),
        _meta: z
          .object({
            progressToken: z.union([z.string(), z.number()]).optional(),
            'io.modelcontextprotocol/related-task': z
              .strictObject({
                taskId: z.string(),
              })
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  })
  .loose();
function parseExtendedCallToolRequest(
  request: unknown
): ExtendedCallToolRequest {
  const parsed = ExtendedCallToolRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;

  const flat = z.flattenError(parsed.error);
  const details =
    Object.entries(flat.fieldErrors)
      .map(([k, v]) => `${k}: ${(v ?? []).join(', ')}`)
      .join('; ') || flat.formErrors.join('; ');

  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid tool request params: ${details}`
  );
}
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
type RequestHandlerFn = (request: unknown, extra?: unknown) => Promise<unknown>;

function getSdkCallToolHandler(server: McpServer): RequestHandlerFn | null {
  const maybeHandlers: unknown = Reflect.get(server.server, '_requestHandlers');
  if (!(maybeHandlers instanceof Map)) return null;

  const handler: unknown = maybeHandlers.get('tools/call');
  return typeof handler === 'function' ? (handler as RequestHandlerFn) : null;
}
export function registerTaskHandlers(server: McpServer): void {
  const sdkCallToolHandler = getSdkCallToolHandler(server);

  if (!sdkCallToolHandler) {
    logWarn(
      'Task call interception disabled: SDK tools/call handler unavailable; task-capable tools require MCP SDK compatibility update',
      { sdkVersion: 'unknown' }
    );
  }

  if (sdkCallToolHandler) {
    server.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const parsedExtra = parseHandlerExtra(extra);
        const context = resolveToolCallContext(parsedExtra);
        const requestId =
          context.requestId !== undefined
            ? String(context.requestId)
            : randomUUID();

        const sessionId = parsedExtra?.sessionId;

        return runWithRequestContext(
          {
            requestId,
            operationId: requestId,
            ...(sessionId ? { sessionId } : {}),
          },
          () => {
            const toolName = request.params.name;

            // Only intercept task-capable tools managed by the local task registry.
            // Delegate all other tools to the SDK handler to avoid shadowing future tools.
            if (!hasTaskCapableTool(toolName)) {
              return sdkCallToolHandler(
                request,
                extra
              ) as Promise<ServerResult>;
            }

            const parsed = parseExtendedCallToolRequest(request);
            return handleToolCallRequest(server, parsed, context);
          }
        );
      }
    );
  }

  server.server.setRequestHandler(TaskGetSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return toTaskSummary(task);
  });

  server.server.setRequestHandler(TaskResultSchema, async (request, extra) => {
    const { taskId } = request.params;
    const { parsedExtra, ownerKey } = resolveOwnerScopedExtra(extra);

    const task = await taskManager.waitForTerminalTask(
      taskId,
      ownerKey,
      parsedExtra?.signal
    );

    if (!task) throwTaskNotFound();

    taskManager.shrinkTtlAfterDelivery(taskId);

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

      return withRelatedTaskMeta(fallback, task.taskId);
    }

    if (task.status === 'cancelled') {
      throw new McpError(ErrorCode.InvalidRequest, 'Task was cancelled', {
        taskId: task.taskId,
        status: 'cancelled',
        ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      });
    }

    if (task.status === 'input_required') {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Task requires additional input',
        { taskId: task.taskId, status: 'input_required' }
      );
    }

    const result: ServerResult = isServerResult(task.result)
      ? task.result
      : { content: [] };

    return withRelatedTaskMeta(result, task.taskId);
  });

  server.server.setRequestHandler(TaskListSchema, (request, extra) => {
    const { ownerKey } = resolveOwnerScopedExtra(extra);
    const cursor = request.params?.cursor;

    const { tasks, nextCursor } = taskManager.listTasks(
      cursor === undefined ? { ownerKey } : { ownerKey, cursor }
    );

    return {
      tasks: tasks.map((task) => toTaskSummary(task)),
      nextCursor,
    };
  });

  server.server.setRequestHandler(TaskCancelSchema, (request, extra) => {
    const { taskId } = request.params;
    const { ownerKey } = resolveOwnerScopedExtra(extra);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();

    abortTaskExecution(taskId);

    emitTaskStatusNotification(server, task);

    return toTaskSummary(task);
  });
}
