import type { Request, Response } from 'express';

import { sendJsonRpcError } from './jsonrpc-http.js';

const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

const MCP_PROTOCOL_VERSIONS = {
  defaultVersion: '2025-03-26',
  supported: new Set<string>(['2025-03-26', '2025-11-25']),
};

function getHeaderValue(req: Request, headerNameLower: string): string | null {
  const value = req.headers[headerNameLower];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function setHeaderValue(
  req: Request,
  headerNameLower: string,
  value: string
): void {
  // Express exposes req.headers as a plain object, but the type is readonly-ish.
  req.headers[headerNameLower] = value;
}

export function ensureMcpProtocolVersionHeader(
  req: Request,
  res: Response
): boolean {
  const raw = getHeaderValue(req, MCP_PROTOCOL_VERSION_HEADER);
  const version = raw?.trim();

  if (!version) {
    setHeaderValue(
      req,
      MCP_PROTOCOL_VERSION_HEADER,
      MCP_PROTOCOL_VERSIONS.defaultVersion
    );
    return true;
  }

  if (!MCP_PROTOCOL_VERSIONS.supported.has(version)) {
    sendJsonRpcError(
      res,
      -32600,
      `Unsupported MCP-Protocol-Version: ${version}`,
      400
    );
    return false;
  }

  return true;
}
