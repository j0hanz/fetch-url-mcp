import { readFileSync } from 'node:fs';

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { type McpIcon, registerCachedContentResource } from './cache.js';
import { config } from './config.js';
import { destroyAgents } from './fetch.js';
import { logError, logInfo, setMcpServer } from './observability.js';
import { registerConfigResource } from './resources.js';
import { registerTools } from './tools.js';
import { shutdownTransformWorkerPool } from './transform.js';

function getLocalIcons(): McpIcon[] | undefined {
  try {
    const iconPath = new URL('../assets/logo.svg', import.meta.url);
    const buffer = readFileSync(iconPath);
    return [
      {
        src: `data:image/svg+xml;base64,${buffer.toString('base64')}`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      },
    ];
  } catch {
    return undefined;
  }
}

function createServerInfo(): {
  name: string;
  version: string;
  icons?: McpIcon[];
} {
  const localIcons = getLocalIcons();

  return {
    name: config.server.name,
    version: config.server.version,
    ...(localIcons ? { icons: localIcons } : {}),
  };
}

function createServerCapabilities(): {
  tools: { listChanged: true };
  resources: { listChanged: true; subscribe: true };
  logging: Record<string, never>;
} {
  return {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    logging: {},
  };
}

function createServerInstructions(serverVersion: string): string {
  try {
    const raw = readFileSync(
      new URL('./instructions.md', import.meta.url),
      'utf8'
    );
    return raw.replaceAll('{{SERVER_VERSION}}', serverVersion).trim();
  } catch {
    return `Instructions unavailable | ${serverVersion}`;
  }
}

function registerInstructionsResource(
  server: McpServer,
  instructions: string
): void {
  server.registerResource(
    'instructions',
    new ResourceTemplate('internal://instructions', { list: undefined }),
    {
      title: `SuperFetch MCP | ${config.server.version}`,
      description: 'Guidance for using the superFetch MCP server.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: instructions,
        },
      ],
    })
  );
}

export function createMcpServer(): McpServer {
  const instructions = createServerInstructions(config.server.version);
  const server = new McpServer(createServerInfo(), {
    capabilities: createServerCapabilities(),
    instructions,
  });

  setMcpServer(server);
  const localIcons = getLocalIcons();
  registerTools(server, localIcons);
  registerCachedContentResource(server, localIcons);
  registerInstructionsResource(server, instructions);
  registerConfigResource(server);

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
  } catch (error: unknown) {
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
