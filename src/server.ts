import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config/index.js';

import { destroyAgents } from './services/fetcher/agents.js';
import { logError, logInfo } from './services/logger.js';

import { registerTools } from './tools/index.js';

import { registerCachedContentResource } from './resources/cached-content.js';

function createServerInfo(): { name: string; version: string } {
  return {
    name: config.server.name,
    version: config.server.version,
  };
}

function createServerCapabilities(): {
  tools: { listChanged: false };
  resources: { listChanged: true; subscribe: true };
  logging: Record<string, never>;
} {
  return {
    tools: { listChanged: false },
    resources: { listChanged: true, subscribe: true },
    logging: {},
  };
}

function createServerInstructions(serverVersion: string): string {
  return `superFetch MCP server |${serverVersion}| A high-performance web content fetching and processing server.`;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(createServerInfo(), {
    capabilities: createServerCapabilities(),
    instructions: createServerInstructions(config.server.version),
  });

  registerTools(server);
  registerCachedContentResource(server);

  return server;
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };
}

function handleShutdownSignal(server: McpServer, signal: string): void {
  process.stderr.write(
    `\n${signal} received, shutting down superFetch MCP server...\n`
  );
  destroyAgents();
  server
    .close()
    .catch((err: unknown) => {
      logError('Error during shutdown', err instanceof Error ? err : undefined);
    })
    .finally(() => {
      process.exit(0);
    });
}

function createShutdownHandler(server: McpServer): (signal: string) => void {
  return (signal: string): void => {
    handleShutdownSignal(server, signal);
  };
}

function registerSignalHandlers(handler: (signal: string) => void): void {
  process.on('SIGINT', () => {
    handler('SIGINT');
  });
  process.on('SIGTERM', () => {
    handler('SIGTERM');
  });
}

async function connectStdioServer(
  server: McpServer,
  transport: StdioServerTransport
): Promise<void> {
  try {
    await server.connect(transport);
    logInfo('superFetch MCP server running on stdio');
  } catch (error) {
    logError(
      'Failed to start stdio server',
      error instanceof Error ? error : undefined
    );
    process.exit(1);
  }
}

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  attachServerErrorHandler(server);
  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
