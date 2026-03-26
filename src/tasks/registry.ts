import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolHandlerExtra } from '../lib/mcp-interop.js';

export type TaskCapableToolSupport = 'optional' | 'forbidden';

export interface TaskCapableToolDescriptor<TArgs = unknown> {
  name: string;
  parseArguments: (args: unknown) => TArgs;
  execute: (args: TArgs, extra?: ToolHandlerExtra) => Promise<ServerResult>;
  getCompletionStatusMessage?: (result: ServerResult) => string | undefined;
  taskSupport?: TaskCapableToolSupport;
}

const taskCapableTools = new Map<string, TaskCapableToolDescriptor>();

export function registerTaskCapableTool<TArgs>(
  descriptor: TaskCapableToolDescriptor<TArgs>
): void {
  taskCapableTools.set(descriptor.name, {
    ...descriptor,
    taskSupport: descriptor.taskSupport ?? 'optional',
  } as TaskCapableToolDescriptor);
}

export function unregisterTaskCapableTool(name: string): void {
  taskCapableTools.delete(name);
}

export function getTaskCapableTool(
  name: string
): TaskCapableToolDescriptor | undefined {
  return taskCapableTools.get(name);
}

export function getTaskCapableToolSupport(
  name: string
): TaskCapableToolSupport | undefined {
  return taskCapableTools.get(name)?.taskSupport;
}

export function hasTaskCapableTool(name: string): boolean {
  return taskCapableTools.has(name);
}

export function hasRegisteredTaskCapableTools(): boolean {
  return taskCapableTools.size > 0;
}

export function setTaskCapableToolSupport(
  name: string,
  support: TaskCapableToolSupport
): void {
  const descriptor = taskCapableTools.get(name);
  if (!descriptor) return;
  descriptor.taskSupport = support;
}
