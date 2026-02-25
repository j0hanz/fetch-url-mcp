import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTools as registerFetchUrlTool } from './fetch-url.js';

export function registerAllTools(server: McpServer): void {
  registerFetchUrlTool(server);
}
