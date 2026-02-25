import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolHandlerExtra } from '../lib/tool-progress.js';

export interface TaskCapableToolDescriptor<TArgs = unknown> {
  name: string;
  parseArguments: (args: unknown) => TArgs;
  execute: (args: TArgs, extra?: ToolHandlerExtra) => Promise<ServerResult>;
}

const taskCapableTools = new Map<string, TaskCapableToolDescriptor>();

export function registerTaskCapableTool<TArgs>(
  descriptor: TaskCapableToolDescriptor<TArgs>
): void {
  taskCapableTools.set(
    descriptor.name,
    descriptor as TaskCapableToolDescriptor
  );
}

export function unregisterTaskCapableTool(name: string): void {
  taskCapableTools.delete(name);
}

export function getTaskCapableTool(
  name: string
): TaskCapableToolDescriptor | undefined {
  return taskCapableTools.get(name);
}

export function hasTaskCapableTool(name: string): boolean {
  return taskCapableTools.has(name);
}
