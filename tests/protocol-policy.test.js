import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureMcpProtocolVersionHeader } from '../dist/http/protocol-policy.js';

describe('protocol-policy', () => {
  it('defaults missing MCP-Protocol-Version header', () => {
    const req = { headers: {} };
    const res = {
      status: () => res,
      json: () => res,
    };

    const ok = ensureMcpProtocolVersionHeader(req, res);

    assert.equal(ok, true);
    assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
  });

  it('rejects unsupported MCP-Protocol-Version header', () => {
    const req = { headers: { 'mcp-protocol-version': '1900-01-01' } };

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

    const ok = ensureMcpProtocolVersionHeader(req, res);

    assert.equal(ok, false);
    assert.equal(statusCode, 400);
    assert.equal(jsonBody.jsonrpc, '2.0');
  });

  it('accepts supported MCP-Protocol-Version header', () => {
    const req = { headers: { 'mcp-protocol-version': '2025-11-25' } };
    const res = {
      status: () => res,
      json: () => res,
    };

    const ok = ensureMcpProtocolVersionHeader(req, res);

    assert.equal(ok, true);
  });
});
