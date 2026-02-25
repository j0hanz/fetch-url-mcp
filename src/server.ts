import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import * as fs from 'node:fs/promises';
import process from 'node:process';

import { z } from 'zod';

import { config } from './config.js';
import { buildServerInstructions } from './instructions.js';
import { abortAllTaskExecutions, registerTaskHandlers } from './mcp.js';
import {
  logError,
  logInfo,
  setLogLevel,
  setMcpServer,
} from './observability.js';
import { registerGetHelpPrompt } from './prompts.js';
import {
  registerCacheResourceTemplate,
  registerInstructionResource,
} from './resources.js';
import { registerTools } from './tools.js';
import { shutdownTransformWorkerPool } from './transform/transform.js';

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

const serverInstructions = buildServerInstructions();

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

interface ServerInfo {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  icons?: IconInfo[];
}

function createServerInfo(icons?: IconInfo[]): ServerInfo {
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

  const serverConfig: ConstructorParameters<typeof McpServer>[1] = {
    capabilities: createServerCapabilities(),
  };
  if (serverInstructions) {
    serverConfig.instructions = serverInstructions;
  }

  const serverInfo = createServerInfo(localIcon ? [localIcon] : undefined);
  const server = new McpServer(serverInfo, serverConfig);

  if (options?.registerObservabilityServer ?? true) {
    setMcpServer(server);
  }

  registerTools(server);
  registerGetHelpPrompt(server, serverInstructions, localIcon);
  registerInstructionResource(server, serverInstructions, localIcon);
  registerCacheResourceTemplate(server, localIcon);
  registerTaskHandlers(server);
  registerLoggingSetLevelHandler(server);
  attachServerErrorHandler(server);

  return server;
}

export async function createMcpServerForHttpSession(): Promise<McpServer> {
  return createMcpServerWithOptions({ registerObservabilityServer: false });
}

function registerLoggingSetLevelHandler(server: McpServer): void {
  const LoggingLevelSchema = z.enum([
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
  ]);

  const SetLevelRequestSchema = z
    .object({
      method: z.literal('logging/setLevel'),
      params: z.object({ level: LoggingLevelSchema }).loose(),
    })
    .loose();

  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    setLogLevel(request.params.level);
    return Promise.resolve({});
  });
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      handler(signal);
    });
  }
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

  registerSignalHandlers(createShutdownHandler(server));
  await connectStdioServer(server, transport);
}
