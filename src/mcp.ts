import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { runWithRequestContext } from './observability.js';
import {
  abortTaskExecution,
  emitTaskStatusNotification,
  type ExtendedCallToolRequest,
  handleToolCallRequest,
  throwTaskNotFound,
  toTaskSummary,
  withRelatedTaskMeta,
} from './tasks/execution.js';
import { taskManager } from './tasks/manager.js';
import {
  isServerResult,
  parseHandlerExtra,
  resolveTaskOwnerKey,
  resolveToolCallContext,
} from './tasks/owner.js';

// Re-export public API so existing consumers (tests, other modules) keep working.
export {
  cancelTasksForOwner,
  abortAllTaskExecutions,
} from './tasks/execution.js';

/* -------------------------------------------------------------------------------------------------
 * Tasks API schemas
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

/* -------------------------------------------------------------------------------------------------
 * Tool call interception (tools/call) with task support
 * ------------------------------------------------------------------------------------------------- */

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
  throw new McpError(ErrorCode.InvalidParams, 'Invalid tool request');
}

/* -------------------------------------------------------------------------------------------------
 * Register handlers
 * ------------------------------------------------------------------------------------------------- */

export function registerTaskHandlers(server: McpServer): void {
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
          const parsed = parseExtendedCallToolRequest(request);
          return handleToolCallRequest(server, parsed, context);
        }
      );
    }
  );

  server.server.setRequestHandler(TaskGetSchema, async (request, extra) => {
    const { taskId } = request.params;
    const parsedExtra = parseHandlerExtra(extra);
    const ownerKey = resolveTaskOwnerKey(parsedExtra);
    const task = taskManager.getTask(taskId, ownerKey);

    if (!task) throwTaskNotFound();

    return Promise.resolve(toTaskSummary(task));
  });

  server.server.setRequestHandler(TaskResultSchema, async (request, extra) => {
    const { taskId } = request.params;
    const parsedExtra = parseHandlerExtra(extra);
    const ownerKey = resolveTaskOwnerKey(parsedExtra);

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

      return Promise.resolve(withRelatedTaskMeta(fallback, task.taskId));
    }

    if (task.status === 'cancelled') {
      throw new McpError(ErrorCode.InvalidRequest, 'Task was cancelled');
    }

    const result: ServerResult = isServerResult(task.result)
      ? task.result
      : { content: [] };

    return Promise.resolve(withRelatedTaskMeta(result, task.taskId));
  });

  server.server.setRequestHandler(TaskListSchema, async (request, extra) => {
    const parsedExtra = parseHandlerExtra(extra);
    const ownerKey = resolveTaskOwnerKey(parsedExtra);
    const cursor = request.params?.cursor;

    const { tasks, nextCursor } = taskManager.listTasks(
      cursor === undefined ? { ownerKey } : { ownerKey, cursor }
    );

    return Promise.resolve({
      tasks: tasks.map((task) => toTaskSummary(task)),
      nextCursor,
    });
  });

  server.server.setRequestHandler(TaskCancelSchema, async (request, extra) => {
    const { taskId } = request.params;
    const parsedExtra = parseHandlerExtra(extra);
    const ownerKey = resolveTaskOwnerKey(parsedExtra);

    const task = taskManager.cancelTask(taskId, ownerKey);
    if (!task) throwTaskNotFound();

    abortTaskExecution(taskId);

    emitTaskStatusNotification(server, task);

    return Promise.resolve(toTaskSummary(task));
  });
}
