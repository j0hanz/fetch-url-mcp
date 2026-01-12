import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isJsonRpcBatchRequest, isMcpRequestBody } from '../dist/http.js';

type Case<T> = {
  input: T;
  expected: boolean;
};

function assertCase<T>(
  testCase: Case<T>,
  predicate: (input: T) => boolean
): void {
  assert.equal(predicate(testCase.input), testCase.expected);
}

describe('mcp-validation', () => {
  describe('isJsonRpcBatchRequest', () => {
    it('empty array', () => {
      assertCase({ input: [], expected: true }, isJsonRpcBatchRequest);
    });

    it('single JSON-RPC request', () => {
      assertCase(
        { input: [{ jsonrpc: '2.0', method: 'test', id: 1 }], expected: true },
        isJsonRpcBatchRequest
      );
    });

    it('multiple JSON-RPC requests', () => {
      assertCase(
        {
          input: [
            { jsonrpc: '2.0', method: 'a', id: 1 },
            { jsonrpc: '2.0', method: 'b', id: 2 },
          ],
          expected: true,
        },
        isJsonRpcBatchRequest
      );
    });

    it('null', () => {
      assertCase({ input: null, expected: false }, isJsonRpcBatchRequest);
    });

    it('undefined', () => {
      assertCase({ input: undefined, expected: false }, isJsonRpcBatchRequest);
    });

    it('object', () => {
      assertCase({ input: {}, expected: false }, isJsonRpcBatchRequest);
    });

    it('single object request (non-array)', () => {
      assertCase(
        { input: { jsonrpc: '2.0', method: 'test', id: 1 }, expected: false },
        isJsonRpcBatchRequest
      );
    });

    it('string', () => {
      assertCase({ input: 'string', expected: false }, isJsonRpcBatchRequest);
    });

    it('number', () => {
      assertCase({ input: 123, expected: false }, isJsonRpcBatchRequest);
    });
  });

  describe('isMcpRequestBody', () => {
    it('valid initialize request', () => {
      assertCase(
        {
          input: { jsonrpc: '2.0', method: 'initialize', id: 1 },
          expected: true,
        },
        isMcpRequestBody
      );
    });

    it('valid tools/list request', () => {
      assertCase(
        {
          input: { jsonrpc: '2.0', method: 'tools/list', id: 'abc' },
          expected: true,
        },
        isMcpRequestBody
      );
    });

    it('valid tools/call request', () => {
      assertCase(
        {
          input: {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'test' },
            id: 1,
          },
          expected: true,
        },
        isMcpRequestBody
      );
    });

    it('notification without id', () => {
      assertCase(
        {
          input: { jsonrpc: '2.0', method: 'notifications/cancelled' },
          expected: true,
        },
        isMcpRequestBody
      );
    });

    it('missing method and jsonrpc', () => {
      assertCase({ input: {}, expected: false }, isMcpRequestBody);
    });

    it('missing jsonrpc', () => {
      assertCase(
        { input: { method: 'test', id: 1 }, expected: false },
        isMcpRequestBody
      );
    });

    it('missing method', () => {
      assertCase(
        { input: { jsonrpc: '2.0', id: 1 }, expected: false },
        isMcpRequestBody
      );
    });

    it('batch payload', () => {
      assertCase({ input: [], expected: false }, isMcpRequestBody);
    });

    it('batch payload with request', () => {
      assertCase(
        { input: [{ jsonrpc: '2.0', method: 'test', id: 1 }], expected: false },
        isMcpRequestBody
      );
    });

    it('null', () => {
      assertCase({ input: null, expected: false }, isMcpRequestBody);
    });

    it('undefined', () => {
      assertCase({ input: undefined, expected: false }, isMcpRequestBody);
    });

    it('string', () => {
      assertCase({ input: 'string', expected: false }, isMcpRequestBody);
    });

    it('number', () => {
      assertCase({ input: 123, expected: false }, isMcpRequestBody);
    });

    it('invalid jsonrpc version', () => {
      assertCase(
        { input: { jsonrpc: '1.0', method: 'test', id: 1 }, expected: false },
        isMcpRequestBody
      );
    });

    it('invalid method type', () => {
      assertCase(
        { input: { jsonrpc: '2.0', method: 123, id: 1 }, expected: false },
        isMcpRequestBody
      );
    });

    it('invalid id type', () => {
      assertCase(
        { input: { jsonrpc: '2.0', method: 'test', id: [] }, expected: false },
        isMcpRequestBody
      );
    });

    it('params array', () => {
      assertCase(
        {
          input: { jsonrpc: '2.0', method: 'tools/call', params: [], id: 1 },
          expected: false,
        },
        isMcpRequestBody
      );
    });
  });
});
