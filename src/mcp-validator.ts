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
const mcpRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  params: paramsSchema.optional(),
});

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

function hasAcceptedMediaType(
  header: string | null | undefined,
  exact: string,
  wildcardPrefix: string
): boolean {
  if (!header) return false;

  return header.split(',').some((rawPart) => {
    const mediaType = rawPart.trim().split(';', 1)[0]?.trim().toLowerCase();
    if (!mediaType) return false;
    if (mediaType === '*/*') return true;
    if (mediaType === exact) return true;
    if (mediaType === wildcardPrefix) return true;
    return false;
  });
}

export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const acceptsJson = hasAcceptedMediaType(
    header,
    'application/json',
    'application/*'
  );
  if (!acceptsJson) return false;

  return hasAcceptedMediaType(header, 'text/event-stream', 'text/*');
}
