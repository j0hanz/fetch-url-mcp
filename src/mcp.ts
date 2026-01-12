import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerCachedContentResource } from './cache.js';
import { config } from './config.js';
import { destroyAgents } from './fetch.js';
import { logError, logInfo } from './observability.js';
import { registerTools } from './tools.js';
import { shutdownTransformWorkerPool } from './transform.js';

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

  Promise.resolve()
    .then(async () => {
      destroyAgents();
      await shutdownTransformWorkerPool();
      await server.close();
    })
    .catch((err: unknown) => {
      logError('Error during shutdown', err instanceof Error ? err : undefined);
    })
    .finally(() => {
      process.exit(0);
    });
}

function createShutdownHandler(server: McpServer): (signal: string) => void {
  let shuttingDown = false;
  let initialSignal: string | null = null;

  return (signal: string): void => {
    if (shuttingDown) {
      logInfo('Shutdown already in progress; ignoring signal', {
        signal,
        initialSignal,
      });
      return;
    }

    shuttingDown = true;
    initialSignal = signal;
    handleShutdownSignal(server, signal);
  };
}

function registerSignalHandlers(handler: (signal: string) => void): void {
  process.once('SIGINT', () => {
    handler('SIGINT');
  });
  process.once('SIGTERM', () => {
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
