import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { config } from './config.js';
import { getErrorMessage } from './errors.js';
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

interface IconInfo {
  src: string;
  mimeType: string;
}

async function getLocalIconInfo(): Promise<IconInfo | undefined> {
  const name = 'logo.svg';
  const mime = 'image/svg+xml';
  try {
    const iconPath = new URL(`../assets/${name}`, import.meta.url);
    const buffer = await fs.readFile(iconPath);
    return {
      src: `data:${mime};base64,${buffer.toString('base64')}`,
      mimeType: mime,
    };
  } catch {
    return undefined;
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let serverInstructions = `
Fetch URL MCP Instructions
(Detailed instructions failed to load - check logs)
`;
try {
  serverInstructions = await fs.readFile(
    path.join(currentDir, 'instructions.md'),
    'utf-8'
  );
} catch (error) {
  console.error(
    '[WARNING] Failed to load instructions.md:',
    getErrorMessage(error)
  );
}

type McpServerCapabilities = NonNullable<
  NonNullable<ConstructorParameters<typeof McpServer>[1]>['capabilities']
>;

function createServerCapabilities(): McpServerCapabilities {
  return {
    logging: {},
    resources: {
      subscribe: true,
      listChanged: true,
    },
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

function createServerInfo(icons?: IconInfo[]): {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  icons?: IconInfo[];
} {
  return {
    name: config.server.name,
    title: 'Fetch URL',
    description:
      'Fetch web pages and convert them into clean, AI-readable Markdown.',
    version: config.server.version,
    websiteUrl: 'https://github.com/j0hanz/fetch-url-mcp',
    ...(icons ? { icons } : {}),
  };
}

function toIconList(icon?: IconInfo): IconInfo[] | undefined {
  return icon ? [icon] : undefined;
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
  const localIcon = await getLocalIconInfo();

  const taskStore = new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();

  const serverConfig: ConstructorParameters<typeof McpServer>[1] = {
    capabilities: createServerCapabilities(),
    taskStore,
    taskMessageQueue,
  };
  if (serverInstructions) {
    serverConfig.instructions = serverInstructions;
  }

  const serverInfo = createServerInfo(toIconList(localIcon));
  const server = new McpServer(serverInfo, serverConfig);

  if (options?.registerObservabilityServer ?? true) {
    setMcpServer(server);
  }

  registerTools(server);
  registerGetHelpPrompt(server, serverInstructions, localIcon);
  registerInstructionResource(server, serverInstructions, localIcon);
  registerCacheResourceTemplate(server, localIcon);
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
    `\n${signal} received, shutting down Fetch URL MCP server...\n`
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
    logInfo('Fetch URL MCP server running on stdio');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to start stdio server: ${err.message}`, {
      cause: error,
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
