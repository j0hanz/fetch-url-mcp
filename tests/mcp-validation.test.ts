import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isJsonRpcBatchRequest,
  isMcpRequestBody,
} from '../dist/http/mcp-validation.js';

type Case<T> = {
  name: string;
  input: T;
  expected: boolean;
};

const BATCH_CASES: readonly Case<unknown>[] = [
  { name: 'empty array', input: [], expected: true },
  {
    name: 'single JSON-RPC request',
    input: [{ jsonrpc: '2.0', method: 'test', id: 1 }],
    expected: true,
  },
  {
    name: 'multiple JSON-RPC requests',
    input: [
      { jsonrpc: '2.0', method: 'a', id: 1 },
      { jsonrpc: '2.0', method: 'b', id: 2 },
    ],
    expected: true,
  },
  { name: 'null', input: null, expected: false },
  { name: 'undefined', input: undefined, expected: false },
  { name: 'object', input: {}, expected: false },
  {
    name: 'single object request (non-array)',
    input: { jsonrpc: '2.0', method: 'test', id: 1 },
    expected: false,
  },
  { name: 'string', input: 'string', expected: false },
  { name: 'number', input: 123, expected: false },
];

const MCP_REQUEST_CASES: readonly Case<unknown>[] = [
  {
    name: 'valid initialize request',
    input: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    expected: true,
  },
  {
    name: 'valid tools/list request',
    input: { jsonrpc: '2.0', method: 'tools/list', id: 'abc' },
    expected: true,
  },
  {
    name: 'valid tools/call request',
    input: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'test' },
      id: 1,
    },
    expected: true,
  },
  {
    name: 'notification without id',
    input: { jsonrpc: '2.0', method: 'notifications/cancelled' },
    expected: true,
  },
  { name: 'missing method and jsonrpc', input: {}, expected: false },
  {
    name: 'missing jsonrpc',
    input: { method: 'test', id: 1 },
    expected: false,
  },
  {
    name: 'missing method',
    input: { jsonrpc: '2.0', id: 1 },
    expected: false,
  },
  { name: 'batch payload', input: [], expected: false },
  {
    name: 'batch payload with request',
    input: [{ jsonrpc: '2.0', method: 'test', id: 1 }],
    expected: false,
  },
  { name: 'null', input: null, expected: false },
  { name: 'undefined', input: undefined, expected: false },
  { name: 'string', input: 'string', expected: false },
  { name: 'number', input: 123, expected: false },
  {
    name: 'invalid jsonrpc version',
    input: { jsonrpc: '1.0', method: 'test', id: 1 },
    expected: false,
  },
  {
    name: 'invalid method type',
    input: { jsonrpc: '2.0', method: 123, id: 1 },
    expected: false,
  },
  {
    name: 'invalid id type',
    input: { jsonrpc: '2.0', method: 'test', id: [] },
    expected: false,
  },
  {
    name: 'params array',
    input: { jsonrpc: '2.0', method: 'tools/call', params: [], id: 1 },
    expected: false,
  },
];

function assertCase<T>(
  testCase: Case<T>,
  predicate: (input: T) => boolean
): void {
  assert.equal(predicate(testCase.input), testCase.expected);
}

describe('mcp-validation', () => {
  describe('isJsonRpcBatchRequest', () => {
    BATCH_CASES.forEach((testCase) => {
      it(testCase.name, () => {
        assertCase(testCase, isJsonRpcBatchRequest);
      });
    });
  });

  describe('isMcpRequestBody', () => {
    MCP_REQUEST_CASES.forEach((testCase) => {
      it(testCase.name, () => {
        assertCase(testCase, isMcpRequestBody);
      });
    });
  });
});
