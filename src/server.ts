import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config.js';
import { abortAllTaskExecutions, registerTaskHandlers } from './mcp.js';
import { logError, logInfo, setMcpServer } from './observability.js';
import { registerGetHelpPrompt } from './prompts.js';
import {
  registerCacheResourceTemplate,
  registerInstructionResource,
} from './resources.js';
import { registerTools } from './tools.js';
import { shutdownTransformWorkerPool } from './transform.js';

/* -------------------------------------------------------------------------------------------------
 * Icons + server info
 * ------------------------------------------------------------------------------------------------- */

async function getLocalIcons(
  signal?: AbortSignal
): Promise<{ src: string; mimeType: string }[] | undefined> {
  const MAX_ICON_BYTES = 2 * 1024 * 1024;

  try {
    const iconPath = new URL('./assets/logo.svg', import.meta.url);

    if (signal?.aborted) return undefined;
    const { size } = await stat(iconPath);
    if (size > MAX_ICON_BYTES) return undefined;

    const base64 = await readFile(iconPath, {
      encoding: 'base64',
      ...(signal ? { signal } : {}),
    });
    return [
      {
        src: `data:image/svg+xml;base64,${base64}`,
        mimeType: 'image/svg+xml',
      },
    ];
  } catch {
    return undefined;
  }
}

type McpServerCapabilities = NonNullable<
  NonNullable<ConstructorParameters<typeof McpServer>[1]>['capabilities']
>;

function createServerCapabilities(): McpServerCapabilities {
  return {
    logging: {},
    resources: {},
    tools: {},
    prompts: {},
    completions: {},
    tasks: {
      list: {},
      cancel: {},
      requests: {
        tools: {
          call: {},
        },
      },
    },
  };
}

async function createServerInstructions(
  serverVersion: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const raw = await readFile(new URL('./instructions.md', import.meta.url), {
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
    return raw.replaceAll('{{SERVER_VERSION}}', serverVersion).trim();
  } catch {
    return `Instructions unavailable | ${serverVersion}`;
  }
}

function createServerInfo(icons?: { src: string; mimeType: string }[]): {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  icons?: { src: string; mimeType: string }[];
} {
  return {
    name: config.server.name,
    title: 'superFetch MCP',
    description:
      'Fetch web pages and convert them into clean, AI-readable Markdown.',
    version: config.server.version,
    websiteUrl: 'https://github.com/j0hanz/super-fetch-mcp-server',
    ...(icons ? { icons } : {}),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Server lifecycle
 * ------------------------------------------------------------------------------------------------- */

export async function createMcpServer(): Promise<McpServer> {
  return createMcpServerWithOptions({ registerObservabilityServer: true });
}

interface CreateMcpServerOptions {
  registerObservabilityServer?: boolean;
}

async function createMcpServerWithOptions(
  options?: CreateMcpServerOptions
): Promise<McpServer> {
  const startupSignal = AbortSignal.timeout(5000);
  const [instructions, localIcons] = await Promise.all([
    createServerInstructions(config.server.version, startupSignal),
    getLocalIcons(startupSignal),
  ]);

  const taskStore = new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();

  const serverConfig: ConstructorParameters<typeof McpServer>[1] = {
    capabilities: createServerCapabilities(),
    taskStore,
    taskMessageQueue,
  };
  if (instructions) {
    serverConfig.instructions = instructions;
  }

  const serverInfo = createServerInfo(localIcons);
  const server = new McpServer(serverInfo, serverConfig);

  if (options?.registerObservabilityServer ?? true) {
    setMcpServer(server);
  }

  registerTools(server);
  registerGetHelpPrompt(server, instructions, localIcons?.[0]);
  registerInstructionResource(server, instructions, localIcons?.[0]);
  registerCacheResourceTemplate(server, localIcons?.[0]);
  registerTaskHandlers(server);

  return server;
}

export async function createMcpServerForHttpSession(): Promise<McpServer> {
  return createMcpServerWithOptions({ registerObservabilityServer: false });
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('[MCP Error]', error instanceof Error ? error : { error });
  };
}

async function shutdownServer(
  server: McpServer,
  signal: string
): Promise<void> {
  process.stderr.write(
    `\n${signal} received, shutting down superFetch MCP server...\n`
  );

  // Ensure any in-flight tool executions are aborted promptly.
  abortAllTaskExecutions();

  await shutdownTransformWorkerPool();
  await server.close();
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

    Promise.resolve()
      .then(() => shutdownServer(server, signal))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logError('Error during shutdown', error);
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.exitCode === undefined) process.exitCode = 0;
      });
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
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to start stdio server: ${err.message}`, {
      cause: err,
    });
  }
}

export async function startStdioServer(): Promise<void> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();

  attachServerErrorHandler(server);
  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
