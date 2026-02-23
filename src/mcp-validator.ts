import { z } from 'zod';

// --- Types ---

export type JsonRpcId = string | number | null;

interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface McpRequestBody {
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
  id: z.union([z.string(), z.number()]).optional(),
  params: paramsSchema.optional(),
});

export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}

function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((value) => extractAcceptMediaType(value.trim()))
    .filter((value) => value.length > 0);
}

function extractAcceptMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}

function hasAcceptedMediaType(
  mediaTypes: readonly string[],
  exact: string,
  wildcardPrefix: string
): boolean {
  return mediaTypes.some((mediaType) => {
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
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = hasAcceptedMediaType(
    mediaTypes,
    'application/json',
    'application/*'
  );
  if (!acceptsJson) return false;

  return hasAcceptedMediaType(mediaTypes, 'text/event-stream', 'text/*');
}
