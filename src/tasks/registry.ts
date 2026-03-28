import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import {
  registerServerLifecycleCleanup,
  type ToolHandlerExtra,
} from '../lib/mcp-interop.js';

export type TaskCapableToolSupport = 'required' | 'optional' | 'forbidden';

export interface TaskCapableToolDescriptor<TArgs = unknown> {
  name: string;
  parseArguments: (args: unknown) => TArgs;
  execute: (args: TArgs, extra?: ToolHandlerExtra) => Promise<ServerResult>;
  getCompletionStatusMessage?: (result: ServerResult) => string | undefined;
  taskSupport?: TaskCapableToolSupport;
  immediateResponse?: string;
}

const taskCapableToolsByServer = new WeakMap<
  McpServer,
  Map<string, TaskCapableToolDescriptor>
>();

function getServerToolMap(
  server: McpServer
): Map<string, TaskCapableToolDescriptor> {
  let toolMap = taskCapableToolsByServer.get(server);
  if (toolMap) return toolMap;

  toolMap = new Map<string, TaskCapableToolDescriptor>();
  taskCapableToolsByServer.set(server, toolMap);
  registerServerLifecycleCleanup(server, () => {
    taskCapableToolsByServer.delete(server);
  });
  return toolMap;
}

export function registerTaskCapableTool<TArgs>(
  server: McpServer,
  descriptor: TaskCapableToolDescriptor<TArgs>
): void {
  getServerToolMap(server).set(descriptor.name, {
    ...descriptor,
    taskSupport: descriptor.taskSupport ?? 'optional',
  } as TaskCapableToolDescriptor);
}

export function unregisterTaskCapableTool(
  server: McpServer,
  name: string
): void {
  getServerToolMap(server).delete(name);
}

export function getTaskCapableTool(
  server: McpServer,
  name: string
): TaskCapableToolDescriptor | undefined {
  return getServerToolMap(server).get(name);
}

export function getTaskCapableToolSupport(
  server: McpServer,
  name: string
): TaskCapableToolSupport | undefined {
  return getServerToolMap(server).get(name)?.taskSupport;
}

export function hasTaskCapableTool(server: McpServer, name: string): boolean {
  return getServerToolMap(server).has(name);
}

export function hasRegisteredTaskCapableTools(server: McpServer): boolean {
  return getServerToolMap(server).size > 0;
}

export function setTaskCapableToolSupport(
  server: McpServer,
  name: string,
  support: TaskCapableToolSupport
): void {
  const descriptor = getServerToolMap(server).get(name);
  if (!descriptor) return;
  descriptor.taskSupport = support;
}
