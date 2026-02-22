import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';

type StructuredContent = Record<string, unknown>;
type ToolResult = {
  structuredContent?: StructuredContent;
  isError?: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage(): void {
  const usage = `
Usage:
  node dist/examples/mcp-fetch-url-client.js <url> [options]

Options:
  --http <url>         Connect via Streamable HTTP (e.g. http://localhost:3000/mcp)
  --task               Use task-based execution with streamed status updates
  --task-ttl <ms>      Task TTL in milliseconds (optional)
  --task-poll <ms>     Task poll interval in milliseconds (optional)
  --no-noise           Skip noise removal
  --force              Force refresh (bypass cache)
  --max-inline <n>     Max inline chars before truncation
  --full               If truncated, read cached resource for full markdown
  --out <path>         Write markdown to file instead of stdout
  --json               Print full structured JSON instead of markdown
  --cmd <executable>   Stdio: command to spawn (default: node)
  --server <path>      Stdio: server entry (default: dist/index.js)
  --cwd <path>         Stdio: working directory for server (default: repo root)
  --env KEY=VALUE      Stdio: add/override environment variable (repeatable)
  -h, --help           Show help
`;
  process.stderr.write(usage);
}

async function findRepoRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, 'package.json');
    try {
      await access(candidate);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return startDir;
      }
      current = parent;
    }
  }
}

function parseEnvOverrides(
  values: string[] | undefined
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!values) {
    return env;
  }
  for (const item of values) {
    const index = item.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid --env value: ${item}`);
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1);
    if (!key) {
      throw new Error(`Invalid --env key in: ${item}`);
    }
    env[key] = value;
  }
  return env;
}

function buildInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function pickTextResource(
  contents: Array<Record<string, unknown>>
): string | null {
  for (const entry of contents) {
    const text = entry['text'];
    if (typeof text === 'string') {
      return text;
    }
  }
  return null;
}

function formatProgress(progress: Progress): string {
  const { message, total } = progress;
  if (typeof total === 'number' && total > 0) {
    const percent = Math.round((progress.progress / total) * 100);
    return `${percent}%${message ? ` ${message}` : ''}`;
  }
  return message ? `${progress.progress} ${message}` : `${progress.progress}`;
}

function getStructuredContent(result: unknown): StructuredContent | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const candidate = result as ToolResult & {
    content?: Array<{ type: string; text?: string }>;
  };
  if (
    candidate.structuredContent &&
    typeof candidate.structuredContent === 'object' &&
    !Array.isArray(candidate.structuredContent)
  ) {
    return candidate.structuredContent;
  }
  if (
    candidate.content &&
    Array.isArray(candidate.content) &&
    candidate.content[0]?.type === 'text' &&
    candidate.content[0].text
  ) {
    try {
      const parsed = JSON.parse(candidate.content[0].text);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as StructuredContent;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function isToolError(result: unknown): result is ToolResult {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  const candidate = result as ToolResult;
  return candidate.isError === true;
}

function getStringField(
  structured: StructuredContent | null,
  key: string
): string | null {
  if (!structured) {
    return null;
  }
  const value = structured[key];
  return typeof value === 'string' ? value : null;
}

const options = {
  help: { type: 'boolean', short: 'h' },
  http: { type: 'string' },
  task: { type: 'boolean' },
  'task-ttl': { type: 'string' },
  'task-poll': { type: 'string' },
  'no-noise': { type: 'boolean' },
  force: { type: 'boolean' },
  'max-inline': { type: 'string' },
  full: { type: 'boolean' },
  out: { type: 'string' },
  json: { type: 'boolean' },
  cmd: { type: 'string' },
  server: { type: 'string' },
  cwd: { type: 'string' },
  env: { type: 'string', multiple: true },
} as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

function requireUrl(positionals: string[]): string {
  const url = positionals[0];
  if (typeof url !== 'string' || url.length === 0) {
    printUsage();
    throw new Error('Missing URL.');
  }
  return url;
}

const targetUrl = requireUrl(positionals);

const maxInlineRaw = values['max-inline'];
const maxInlineChars =
  maxInlineRaw !== undefined ? Number(maxInlineRaw) : undefined;
if (maxInlineRaw !== undefined && Number.isNaN(maxInlineChars)) {
  throw new Error(`Invalid --max-inline value: ${maxInlineRaw}`);
}

const taskTtlRaw = values['task-ttl'];
const taskTtl = taskTtlRaw !== undefined ? Number(taskTtlRaw) : undefined;
if (taskTtlRaw !== undefined && Number.isNaN(taskTtl)) {
  throw new Error(`Invalid --task-ttl value: ${taskTtlRaw}`);
}

const taskPollRaw = values['task-poll'];
const taskPoll = taskPollRaw !== undefined ? Number(taskPollRaw) : undefined;
if (taskPollRaw !== undefined && Number.isNaN(taskPoll)) {
  throw new Error(`Invalid --task-poll value: ${taskPollRaw}`);
}

const onProgress = (progress: Progress): void => {
  process.stderr.write(`[progress] ${formatProgress(progress)}\n`);
};

async function run(): Promise<void> {
  let transport: Transport | null = null;
  const client = new Client(
    { name: 'fetch-url-mcp-client', version: '0.1.0' },
    { capabilities: {} }
  );

  try {
    if (values.http) {
      const endpoint = new URL(values.http);
      transport = new StreamableHTTPClientTransport(endpoint) as Transport;
    } else {
      const command = values.cmd ?? process.execPath;
      const repoRoot = await findRepoRoot(__dirname);
      const serverPath = values.server ?? path.join(repoRoot, 'dist/index.js');
      const cwd = values.cwd ?? repoRoot;

      try {
        await access(serverPath);
      } catch {
        throw new Error(
          `Server entry not found at ${serverPath}. Run \"npm run build\" first or set --server.`
        );
      }

      const env = {
        ...buildInheritedEnv(),
        ...parseEnvOverrides(values.env),
      };

      transport = new StdioClientTransport({
        command,
        args: [serverPath, '--stdio'],
        cwd,
        env,
        stderr: 'inherit',
      }) as Transport;
    }

    await client.connect(transport);

    const toolArguments: {
      url: string;
      skipNoiseRemoval: boolean;
      forceRefresh: boolean;
      maxInlineChars?: number;
    } = {
      url: targetUrl,
      skipNoiseRemoval: values['no-noise'] ?? false,
      forceRefresh: values.force ?? false,
    };

    if (typeof maxInlineChars === 'number') {
      toolArguments.maxInlineChars = maxInlineChars;
    }

    const taskOptions: { ttl?: number; pollInterval?: number } = {};
    if (typeof taskTtl === 'number') {
      taskOptions.ttl = taskTtl;
    }
    if (typeof taskPoll === 'number') {
      taskOptions.pollInterval = taskPoll;
    }

    const requestOptions = values.task
      ? { onprogress: onProgress, task: taskOptions }
      : { onprogress: onProgress };

    const result = values.task
      ? await callToolStream(client, toolArguments, requestOptions)
      : await client.callTool(
          {
            name: 'fetch-url',
            arguments: toolArguments,
          },
          undefined,
          requestOptions
        );

    if (isToolError(result)) {
      const errorPayload = getStructuredContent(result) ?? {
        message: 'Fetch failed',
      };
      process.stderr.write(`${JSON.stringify(errorPayload, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }

    const structured = getStructuredContent(result);

    if (values.json) {
      const payload = structured ?? result;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    let markdown = getStringField(structured, 'markdown');
    if (values.full) {
      const cacheResourceUri = getStringField(structured, 'cacheResourceUri');
      if (cacheResourceUri) {
        const resource = await client.readResource({
          uri: cacheResourceUri,
        });
        const text = pickTextResource(resource.contents);
        if (text) {
          markdown = text;
        }
      }
    }

    if (!markdown) {
      throw new Error('No markdown returned from fetch-url.');
    }

    if (values.out) {
      await writeFile(values.out, markdown, 'utf8');
    } else {
      process.stdout.write(`${markdown}\n`);
    }
  } finally {
    if (transport) {
      await transport.close();
    }
  }
}

async function callToolStream(
  client: Client,
  toolArguments: {
    url: string;
    skipNoiseRemoval: boolean;
    forceRefresh: boolean;
    maxInlineChars?: number;
  },
  requestOptions: {
    onprogress: (progress: Progress) => void;
    task?: {
      ttl?: number;
      pollInterval?: number;
    };
  }
): Promise<unknown> {
  const stream = client.experimental.tasks.callToolStream(
    {
      name: 'fetch-url',
      arguments: toolArguments,
    },
    undefined,
    requestOptions
  );

  let finalResult: unknown = null;

  for await (const message of stream) {
    if (message.type === 'taskCreated') {
      process.stderr.write(`[task] created ${message.task.taskId}\n`);
      continue;
    }
    if (message.type === 'taskStatus') {
      const statusMessage = message.task.statusMessage
        ? ` ${message.task.statusMessage}`
        : '';
      process.stderr.write(`[task] ${message.task.status}${statusMessage}\n`);
      continue;
    }
    if (message.type === 'result') {
      finalResult = message.result;
      continue;
    }
    if (message.type === 'error') {
      throw new Error(message.error.message ?? 'Task failed');
    }
  }

  if (finalResult === null) {
    throw new Error('Task stream ended without a result.');
  }

  return finalResult;
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
