import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config/index.js';

import { destroyAgents } from './services/fetcher.js';
import { logError, logInfo } from './services/logger.js';
import { destroyTransformWorkers } from './services/transform-worker-pool.js';

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
      instructions: `superFetch MCP server v${config.server.version} - AI-optimized web content fetching with JSONL/Markdown output. Provides tools for fetching, parsing, and transforming web content into structured formats suitable for LLM consumption. Supports resource subscriptions for cache updates.`,
    }
  );

  registerTools(server);
  registerResources(server);

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };

  const handleShutdown = async (signal: string): Promise<void> => {
    process.stderr.write(
      `\n${signal} received, shutting down superFetch MCP server...\n`
    );
    destroyAgents();
    await destroyTransformWorkers();
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

  process.on('SIGINT', () => {
    void handleShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void handleShutdown('SIGTERM');
  });

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
