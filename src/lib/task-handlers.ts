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
  parseExtendedCallToolRequest,
  withRelatedTaskMeta,
} from '../tasks/call-contract.js';
import {
  abortTaskExecution,
  emitTaskStatusNotification,
  handleToolCallRequest,
  throwTaskNotFound,
  toTaskSummary,
} from '../tasks/execution.js';
import { taskManager } from '../tasks/manager.js';
import {
  hasRegisteredTaskCapableTools,
  hasTaskCapableTool,
} from '../tasks/manager.js';
import {
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
} from '../tasks/owner.js';
import { logWarn, runWithRequestContext } from './core.js';
import { getSdkCallToolHandler } from './sdk-interop.js';

export {
  cancelTasksForOwner,
  abortAllTaskExecutions,
} from '../tasks/execution.js';

/* -------------------------------------------------------------------------------------------------
 * Task handler schemas and registration
 * ------------------------------------------------------------------------------------------------- */

const TaskGetSchema = z.looseObject({
  method: z.literal('tasks/get'),
  params: z.looseObject({ taskId: z.string() }),
});
const TaskListSchema = z.looseObject({
  method: z.literal('tasks/list'),
  params: z
    .looseObject({
      cursor: z.string().optional(),
    })
    .optional(),
});
const TaskCancelSchema = z.looseObject({
  method: z.literal('tasks/cancel'),
  params: z.looseObject({ taskId: z.string() }),
});
const TaskResultSchema = z.looseObject({
  method: z.literal('tasks/result'),
  params: z.looseObject({ taskId: z.string() }),
});
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
export function registerTaskHandlers(
  server: McpServer,
  options?: TaskHandlerRegistrationOptions
): TaskHandlerRegistrationResult {
  const sdkCallToolHandler = getSdkCallToolHandler(server);
  const taskCapableToolsRegistered = hasRegisteredTaskCapableTools();
  const requireInterception = options?.requireInterception ?? true;

  if (!sdkCallToolHandler) {
    if (taskCapableToolsRegistered && requireInterception) {
      throw new Error(
        'Task-capable tools are registered but SDK tools/call interception is unavailable. Upgrade compatibility or disable strict interception with TASKS_REQUIRE_INTERCEPTION=false.'
      );
    }

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
            if (!hasTaskCapableTool(toolName)) {
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

    try {
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

      const result: ServerResult = isServerResult(task.result)
        ? task.result
        : { content: [] };

      return withRelatedTaskMeta(result, task.taskId);
    } finally {
      // Shrink TTL only after the result has been fully constructed and
      // is about to be delivered — avoids premature expiry if result
      // construction throws.
      taskManager.shrinkTtlAfterDelivery(taskId);
    }
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

  return {
    interceptedToolsCall: sdkCallToolHandler !== null,
    taskCapableToolsRegistered,
  };
}
