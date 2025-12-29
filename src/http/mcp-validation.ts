import type { McpRequestBody } from '../config/types/runtime.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  if (!isRecord(body)) return false;

  const { method, id, jsonrpc, params } = body;
  const methodValid = method === undefined || typeof method === 'string';
  const idValid =
    id === undefined || typeof id === 'string' || typeof id === 'number';
  const jsonrpcValid = jsonrpc === undefined || jsonrpc === '2.0';
  const paramsValid = params === undefined || typeof params === 'object';

  return methodValid && idValid && jsonrpcValid && paramsValid;
}
