import {
  ErrorCode,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { createMcpError } from '../lib/mcp-interop.js';
import { formatZodError } from '../lib/zod.js';

const MIN_TASK_TTL_MS = 1_000;
const MAX_TASK_TTL_MS = 86_400_000;

const relatedTaskMetaSchema = z.strictObject({
  taskId: z.string(),
});

const toolCallMetaSchema = z.looseObject({
  progressToken: z.union([z.string(), z.number()]).optional(),
  'io.modelcontextprotocol/related-task': relatedTaskMetaSchema.optional(),
});

export const extendedCallToolRequestSchema = z.looseObject({
  method: z.literal('tools/call'),
  params: z.strictObject({
    name: z.string().min(1, 'Tool name required'),
    arguments: z.record(z.string(), z.unknown()).optional(),
    task: z
      .strictObject({
        ttl: z
          .number()
          .int()
          .min(MIN_TASK_TTL_MS, `Minimum ${MIN_TASK_TTL_MS}ms`)
          .max(MAX_TASK_TTL_MS, `Maximum ${MAX_TASK_TTL_MS}ms`)
          .optional(),
      })
      .optional(),
    _meta: toolCallMetaSchema.optional(),
  }),
});

export type ExtendedCallToolRequest = z.infer<
  typeof extendedCallToolRequestSchema
>;
export type ToolCallRequestMeta = ExtendedCallToolRequest['params']['_meta'];

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

  const sanitized = { ...meta };
  delete sanitized['io.modelcontextprotocol/related-task'];
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildRelatedTaskMeta(
  taskId: string,
  meta?: ToolCallRequestMeta
): Record<string, unknown> {
  return {
    ...(sanitizeToolCallMeta(meta) ?? {}),
    'io.modelcontextprotocol/related-task': { taskId },
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
      'io.modelcontextprotocol/related-task': { taskId },
    },
  };
}
