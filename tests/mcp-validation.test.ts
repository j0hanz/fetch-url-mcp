import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isJsonRpcBatchRequest,
  isMcpRequestBody,
} from '../dist/http/mcp-validation.js';

describe('mcp-validation', () => {
  describe('isJsonRpcBatchRequest', () => {
    it('returns true for array payloads', () => {
      assert.equal(isJsonRpcBatchRequest([]), true);
      assert.equal(
        isJsonRpcBatchRequest([{ jsonrpc: '2.0', method: 'test', id: 1 }]),
        true
      );
      assert.equal(
        isJsonRpcBatchRequest([
          { jsonrpc: '2.0', method: 'a', id: 1 },
          { jsonrpc: '2.0', method: 'b', id: 2 },
        ]),
        true
      );
    });

    it('returns false for non-array payloads', () => {
      assert.equal(isJsonRpcBatchRequest(null), false);
      assert.equal(isJsonRpcBatchRequest(undefined), false);
      assert.equal(isJsonRpcBatchRequest({}), false);
      assert.equal(
        isJsonRpcBatchRequest({ jsonrpc: '2.0', method: 'test', id: 1 }),
        false
      );
      assert.equal(isJsonRpcBatchRequest('string'), false);
      assert.equal(isJsonRpcBatchRequest(123), false);
    });
  });

  describe('isMcpRequestBody', () => {
    it('accepts valid JSON-RPC 2.0 request objects', () => {
      assert.equal(
        isMcpRequestBody({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
        true
      );
      assert.equal(
        isMcpRequestBody({ jsonrpc: '2.0', method: 'tools/list', id: 'abc' }),
        true
      );
      assert.equal(
        isMcpRequestBody({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'test' },
          id: 1,
        }),
        true
      );
    });

    it('accepts notification objects (no id)', () => {
      assert.equal(
        isMcpRequestBody({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
        true
      );
    });

    it('rejects array (batch) payloads', () => {
      assert.equal(isMcpRequestBody([]), false);
      assert.equal(
        isMcpRequestBody([{ jsonrpc: '2.0', method: 'test', id: 1 }]),
        false
      );
    });

    it('rejects null and primitives', () => {
      assert.equal(isMcpRequestBody(null), false);
      assert.equal(isMcpRequestBody(undefined), false);
      assert.equal(isMcpRequestBody('string'), false);
      assert.equal(isMcpRequestBody(123), false);
    });

    it('rejects invalid jsonrpc version', () => {
      assert.equal(
        isMcpRequestBody({ jsonrpc: '1.0', method: 'test', id: 1 }),
        false
      );
    });

    it('rejects invalid method type', () => {
      assert.equal(
        isMcpRequestBody({ jsonrpc: '2.0', method: 123, id: 1 }),
        false
      );
    });

    it('rejects invalid id type', () => {
      assert.equal(
        isMcpRequestBody({ jsonrpc: '2.0', method: 'test', id: [] }),
        false
      );
    });
  });
});
