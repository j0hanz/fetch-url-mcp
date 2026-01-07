import type { McpRequestBody } from '../config/types/runtime.js';

import { isRecord } from '../utils/guards.js';

export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  if (!isRecord(body) || Array.isArray(body)) return false;

  const { method, id, jsonrpc, params } = body;
  const methodValid = method === undefined || typeof method === 'string';
  const idValid =
    id === undefined || typeof id === 'string' || typeof id === 'number';
  const jsonrpcValid = jsonrpc === undefined || jsonrpc === '2.0';
  const paramsValid =
    params === undefined || (typeof params === 'object' && params !== null);

  return methodValid && idValid && jsonrpcValid && paramsValid;
}
