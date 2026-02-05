import { z } from 'zod';

// --- Types ---

export type JsonRpcId = string | number | null;

export interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpRequestBody {
  jsonrpc: '2.0';
  method: string;
  id?: JsonRpcId;
  params?: McpRequestParams;
}

// --- Validation ---

const paramsSchema = z.looseObject({});
const mcpRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    params: paramsSchema.optional(),
  })
  .strict();

export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}

export function acceptsEventStream(header: string | null | undefined): boolean {
  if (!header) return false;
  return header
    .split(',')
    .some((value) =>
      value.trim().toLowerCase().startsWith('text/event-stream')
    );
}
