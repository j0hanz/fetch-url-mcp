import type { McpRequestBody } from '../config/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalId(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number'
  );
}

function isOptionalJsonRpc(value: unknown): boolean {
  return value === undefined || value === '2.0';
}

function isOptionalParams(value: unknown): boolean {
  return value === undefined || typeof value === 'object';
}

function areMcpFieldsValid(body: Record<string, unknown>): boolean {
  if (!isOptionalString(body.method)) return false;
  if (!isOptionalId(body.id)) return false;
  if (!isOptionalJsonRpc(body.jsonrpc)) return false;
  if (!isOptionalParams(body.params)) return false;
  return true;
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  if (!isRecord(body)) return false;
  return areMcpFieldsValid(body);
}
