import { z } from 'zod';

import type { McpRequestBody } from '../config/types/runtime.js';

const paramsSchema = z.looseObject({});

const mcpRequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number()]).optional(),
  params: paramsSchema.optional(),
});

export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}
