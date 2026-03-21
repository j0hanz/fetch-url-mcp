import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  resolveMcpSessionIdByServer,
  unregisterMcpSessionServer,
  unregisterMcpSessionServerByServer,
} from '../lib/core.js';
import { cancelTasksForOwner } from '../lib/task-handlers.js';

import {
  closeMcpServerBestEffort,
  closeTransportBestEffort,
} from './helpers.js';

interface SessionRecordLike {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SessionTeardownOptions {
  cancelMessage: string;
  closeServerReason?: string;
  closeTransportReason?: string;
  unregisterByServer?: boolean;
  awaitClose?: boolean;
}

type SessionCloseOptions = Pick<
  SessionTeardownOptions,
  'closeServerReason' | 'closeTransportReason' | 'awaitClose'
>;

function cancelSessionTasks(server: McpServer, message: string): string | null {
  const sessionId = resolveMcpSessionIdByServer(server);
  if (!sessionId) return null;

  cancelTasksForOwner(`session:${sessionId}`, message);
  unregisterMcpSessionServer(sessionId);
  return sessionId;
}

async function closeSessionResources(
  session: SessionRecordLike,
  options: SessionCloseOptions
): Promise<void> {
  const closeTasks: Promise<unknown>[] = [];
  if (options.closeTransportReason) {
    closeTasks.push(
      closeTransportBestEffort(session.transport, options.closeTransportReason)
    );
  }
  if (options.closeServerReason) {
    closeTasks.push(
      closeMcpServerBestEffort(session.server, options.closeServerReason)
    );
  }

  if (options.awaitClose && closeTasks.length > 0) {
    await Promise.all(closeTasks);
  }
}

export async function teardownSessionResources(
  session: SessionRecordLike,
  options: SessionTeardownOptions
): Promise<void> {
  cancelSessionTasks(session.server, options.cancelMessage);

  if (options.unregisterByServer) {
    unregisterMcpSessionServerByServer(session.server);
  }

  await closeSessionResources(session, options);
}

export async function teardownUnregisteredSessionResources(
  session: SessionRecordLike,
  context: string
): Promise<void> {
  await closeSessionResources(session, {
    closeTransportReason: context,
    closeServerReason: context,
    awaitClose: true,
  });
}

export function teardownSessionRegistration(
  server: McpServer,
  cancelMessage: string
): void {
  cancelSessionTasks(server, cancelMessage);
}
