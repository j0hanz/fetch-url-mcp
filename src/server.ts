import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config/index.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { logError, logInfo } from './services/logger.js';

/**
 * Creates and configures the MCP server instance
 * Using McpServer (high-level API) instead of deprecated Server class
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });

  // Register all features using the modern API
  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

// Export function to start server with stdio transport
export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  // Error handlers
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };

  process.on('SIGINT', async () => {
    process.stdout.write('\nShutting down superFetch MCP server...\n');
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
  logInfo('superFetch MCP server running on stdio');
}
