import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import * as fs from 'node:fs/promises';
import process from 'node:process';

import {
  config,
  getSessionId,
  logError,
  Loggers,
  logInfo,
  logNotice,
  setLogLevel,
  setMcpServer,
} from './lib/core.js';
import { toError } from './lib/error/index.js';
import { setTaskToolCallCapability } from './lib/mcp-interop.js';
import type { IconInfo } from './lib/utils.js';

import {
  buildServerInstructions,
  registerGetHelpPrompt,
  registerInstructionResource,
} from './resources/index.js';
import { abortAllTaskExecutions, registerTaskHandlers } from './tasks/index.js';
import { registerTools as registerFetchUrlTool } from './tools/index.js';
import { shutdownTransformWorkerPool } from './transform/index.js';

/* -------------------------------------------------------------------------------------------------
 * Icons + server info
 * ------------------------------------------------------------------------------------------------- */

let iconPromise: Promise<IconInfo | undefined> | null = null;

async function getLocalIconInfo(): Promise<IconInfo | undefined> {
  iconPromise ??= (async () => {
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
  })();
  return iconPromise;
}

const serverInstructions = buildServerInstructions();

type McpServerCapabilities = NonNullable<
  NonNullable<ConstructorParameters<typeof McpServer>[1]>['capabilities']
>;

function createServerCapabilities(): McpServerCapabilities {
  return {
    completions: {},
    logging: {},
    resources: { subscribe: true, listChanged: true },
    // SDK auto-adds listChanged to tools capability at runtime.
    tools: {},
    prompts: {},
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

function syncTaskCapabilityAdvertisement(
  server: McpServer,
  taskToolCallEnabled: boolean
): void {
  setTaskToolCallCapability(server, taskToolCallEnabled);
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

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

function shouldRegisterObservabilityServer(
  options?: CreateMcpServerOptions
): boolean {
  return options?.registerObservabilityServer ?? true;
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

  const toolControls = registerFetchUrlTool(server);
  registerGetHelpPrompt(server, serverInstructions, localIcon);
  registerInstructionResource(server, serverInstructions, localIcon);
  const taskRegistration = registerTaskHandlers(server, {
    requireInterception: config.tasks.requireInterception,
  });
  const taskToolCallEnabled = taskRegistration.interceptedToolsCall;
  toolControls.setTaskSupport(taskToolCallEnabled ? 'optional' : 'forbidden');
  syncTaskCapabilityAdvertisement(server, taskToolCallEnabled);
  registerLoggingSetLevelHandler(server);
  attachServerErrorHandler(server);

  // Set global ref only after all registrations succeed so callers
  // never observe a half-initialised server instance.
  if (shouldRegisterObservabilityServer(options)) {
    setMcpServer(server);
  }

  return server;
}

export async function createMcpServerForHttpSession(): Promise<McpServer> {
  return createMcpServerWithOptions({ registerObservabilityServer: false });
}

function registerLoggingSetLevelHandler(server: McpServer): void {
  server.server.setRequestHandler(SetLevelRequestSchema, (request) => {
    const sessionId = getSessionId();
    setLogLevel(request.params.level, sessionId);
    logNotice(
      'Logging level updated',
      {
        level: request.params.level,
        scope: sessionId ? 'session' : 'stdio',
      },
      'logging'
    );
    return {};
  });
}

function attachServerErrorHandler(server: McpServer): void {
  server.server.onerror = (error) => {
    logError('MCP server error', toError(error), Loggers.LOG_SERVER);
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

  // Run shutdown steps independently so a failure in one does not
  // prevent the others from executing.
  const results = await Promise.allSettled([
    shutdownTransformWorkerPool(),
    server.close(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      logError(
        'Shutdown step failed',
        toError(result.reason),
        Loggers.LOG_SERVER
      );
    }
  }
}

function createShutdownHandler(
  server: McpServer
): (signal: string) => Promise<void> {
  let shuttingDown = false;
  let initialSignal: string | null = null;
  let shutdownPromise: Promise<void> | null = null;

  return (signal: string): Promise<void> => {
    if (shuttingDown) {
      logInfo(
        'Shutdown already in progress; ignoring signal',
        {
          signal,
          initialSignal,
        },
        Loggers.LOG_SERVER
      );
      return shutdownPromise ?? Promise.resolve();
    }

    shuttingDown = true;
    initialSignal = signal;

    shutdownPromise = Promise.resolve()
      .then(() => shutdownServer(server, signal))
      .catch((err: unknown) => {
        const error = toError(err);
        logError('Error during shutdown', error, Loggers.LOG_SERVER);
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.exitCode === undefined) process.exitCode = 0;
      });

    return shutdownPromise;
  };
}

function registerSignalHandlers(
  handler: (signal: string) => Promise<void>
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void handler(signal);
    });
  }
}

async function connectStdioServer(
  server: McpServer,
  transport: StdioServerTransport
): Promise<void> {
  try {
    await server.connect(transport);
    logInfo(
      'Fetch URL MCP server running on stdio',
      undefined,
      Loggers.LOG_SERVER
    );
  } catch (error: unknown) {
    const err = toError(error);
    throw Error(`Failed to start stdio server: ${err.message}`, {
      cause: error,
    });
  }
}

export async function startStdioServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
}> {
  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  const shutdown = createShutdownHandler(server);

  registerSignalHandlers(shutdown);
  await connectStdioServer(server, transport);

  return { shutdown };
}
