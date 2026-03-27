import { randomUUID } from 'node:crypto';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logDebug, logWarn, runWithRequestContext } from '../lib/core.js';
import { createMcpError, getSdkCallToolHandler } from '../lib/mcp-interop.js';

import {
  parseExtendedCallToolRequest,
  withRelatedTaskMeta,
} from './call-contract.js';
import {
  abortTaskExecution,
  emitTaskStatusNotification,
  handleToolCallRequest,
  throwTaskNotFound,
  toTaskSummary,
} from './execution.js';
import { taskManager } from './manager.js';
import {
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
} from './owner.js';
import {
  hasRegisteredTaskCapableTools,
  hasTaskCapableTool,
} from './registry.js';

export { cancelTasksForOwner, abortAllTaskExecutions } from './execution.js';

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
    task.statusMessage ?? 'Task execution failed',
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
      throw new Error(
        'Task-capable tools are registered but SDK tools/call interception is unavailable. Upgrade compatibility or disable strict interception with TASKS_REQUIRE_INTERCEPTION=false.'
      );
    }

    logWarn(
      'Task call interception disabled: SDK tools/call handler unavailable; task-capable tools require MCP SDK compatibility update',
      { sdkVersion: 'unknown' },
      'tasks'
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
                taskRequested: parsed.params.task !== undefined,
                hasProgressToken:
                  parsed.params._meta?.progressToken !== undefined,
              },
              'tasks'
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
    logDebug('tasks/get requested', { taskId }, 'tasks');
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return toTaskSummary(task);
  });

  server.server.setRequestHandler(TaskResultSchema, async (request, extra) => {
    const { taskId } = request.params;
    const { parsedExtra, ownerKey } = resolveOwnerScopedExtra(extra);
    logDebug('tasks/result requested', { taskId }, 'tasks');

    const task = await taskManager.waitForTerminalTask(
      taskId,
      ownerKey,
      parsedExtra?.signal
    );

    if (!task) throwTaskNotFound();

    try {
      if (task.status === 'cancelled') {
        throwStoredTaskError(task);
      }

      if (task.status === 'failed') {
        if (task.error) {
          throwStoredTaskError(task);
        }

        const failedResult = (task.result ?? null) as ServerResult | null;
        if (failedResult) {
          return withRelatedTaskMeta(failedResult, task.taskId);
        }

        throwStoredTaskError(task);
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
    logDebug(
      'tasks/list requested',
      { hasCursor: cursor !== undefined },
      'tasks'
    );

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
    logDebug('tasks/cancel requested', { taskId }, 'tasks');

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
