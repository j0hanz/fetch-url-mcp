import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureMcpProtocolVersionHeader } from '../dist/http.js';

function createResponse() {
  const res = {
    status: () => res,
    json: () => res,
  };

  return res;
}

function createStatusJsonCapture() {
  let statusCode;
  let jsonBody;
  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (payload) => {
      jsonBody = payload;
    },
  };

  return { res, getStatusCode: () => statusCode, getJsonBody: () => jsonBody };
}

function testDefaultsMissingHeader() {
  const req = { headers: {} };
  const { res, getStatusCode, getJsonBody } = createStatusJsonCapture();

  const ok = ensureMcpProtocolVersionHeader(req, res);

  assert.equal(ok, false);
  assert.equal(getStatusCode(), 400);
  assert.equal(getJsonBody().jsonrpc, '2.0');
  assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
}

function testRejectsUnsupportedHeader() {
  const req = { headers: { 'mcp-protocol-version': '1900-01-01' } };
  const { res, getStatusCode, getJsonBody } = createStatusJsonCapture();

  const ok = ensureMcpProtocolVersionHeader(req, res);

  assert.equal(ok, false);
  assert.equal(getStatusCode(), 400);
  assert.equal(getJsonBody().jsonrpc, '2.0');
}

function testRejectsLegacyHeader() {
  const req = { headers: { 'mcp-protocol-version': '2025-03-26' } };
  const { res, getStatusCode, getJsonBody } = createStatusJsonCapture();

  const ok = ensureMcpProtocolVersionHeader(req, res);

  assert.equal(ok, false);
  assert.equal(getStatusCode(), 400);
  assert.equal(getJsonBody().jsonrpc, '2.0');
}

function testAcceptsSupportedHeader() {
  const req = { headers: { 'mcp-protocol-version': '2025-11-25' } };
  const res = createResponse();

  const ok = ensureMcpProtocolVersionHeader(req, res);

  assert.equal(ok, true);
}

function registerProtocolPolicyTests() {
  describe('protocol-policy', () => {
    it('defaults missing MCP-Protocol-Version header', () => {
      testDefaultsMissingHeader();
    });
    it('rejects unsupported MCP-Protocol-Version header', () => {
      testRejectsUnsupportedHeader();
    });
    it('rejects legacy MCP-Protocol-Version header', () => {
      testRejectsLegacyHeader();
    });
    it('accepts supported MCP-Protocol-Version header', () => {
      testAcceptsSupportedHeader();
    });
  });
}

registerProtocolPolicyTests();
