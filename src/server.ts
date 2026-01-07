import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config/index.js';

import { destroyAgents } from './services/fetcher/agents.js';
import { logError, logInfo } from './services/logger.js';

import { registerTools } from './tools/index.js';

import { registerResources } from './resources/index.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: config.server.name,
      version: config.server.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: true, subscribe: true },
        logging: {},
      },
      instructions: `superFetch MCP server |${config.server.version}| A high-performance web content fetching and processing server.`,
    }
  );

  registerTools(server);
  registerResources(server);

  return server;
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };
}

function createShutdownHandler(server: McpServer): (signal: string) => void {
  return (signal: string): void => {
    process.stderr.write(
      `\n${signal} received, shutting down superFetch MCP server...\n`
    );
    destroyAgents();
    server
      .close()
      .catch((err: unknown) => {
        logError(
          'Error during shutdown',
          err instanceof Error ? err : undefined
        );
      })
      .finally(() => {
        process.exit(0);
      });
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
