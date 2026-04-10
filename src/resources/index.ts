import {
  completable,
  type GetPromptResult,
  type McpServer,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';

import { z } from 'zod';

import { config } from '../lib/config.js';
import { buildOptionalIcons, type IconInfo } from '../lib/utils.js';

import { FETCH_URL_TOOL_NAME } from '../tools/index.js';

// Area contract: MCP resources and prompts for server guidance.
// Export only assistant-facing help surfaces; keep tool execution and transport wiring out.

export function registerInstructionResource(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    'fetch-url-mcp-instructions',
    'internal://instructions',
    {
      title: 'Server Instructions',
      description: 'Guidance for using the Fetch URL MCP server.',
      mimeType: 'text/markdown',
      annotations: {
        audience: ['assistant'],
        priority: 0.9,
      },
      ...buildOptionalIcons(iconInfo),
    },
    (uri): ReadResourceResult => ({
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

export const HELP_TOPICS = [
  'capabilities',
  'workflows',
  'constraints',
  'errors',
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export function extractSection(
  instructions: string,
  topic: HelpTopic
): string | undefined {
  const sections = instructions.split(/\n(?=# )/g);
  const match = sections.find((s) => s.toLowerCase().startsWith(`# ${topic}`));
  return match?.trim();
}

export function filterInstructions(
  instructions: string,
  topic?: string
): string {
  if (!topic) return instructions;
  const normalized = topic.toLowerCase().trim() as HelpTopic;
  if (!HELP_TOPICS.includes(normalized)) return instructions;
  return extractSection(instructions, normalized) ?? instructions;
}

export function buildServerInstructions(): string {
  const maxHtmlSizeMb = config.constants.maxHtmlBytes / 1024 / 1024;

  return `# Fetch public webpages and return clean, readable Markdown.

# Capabilities
- Tool: \`${FETCH_URL_TOOL_NAME}\` — fetch a URL, return Markdown with metadata.
- Resource: \`internal://instructions\` — this document.
- Prompt: \`get-help\` — returns these instructions. Accepts optional \`topic\` filter (${HELP_TOPICS.join(' | ')}).

# Workflows

## Standard
Call \`${FETCH_URL_TOOL_NAME}\` with \`{ url }\` → read \`markdown\` from result. Check \`truncated: true\` for incomplete content.

## Progress
Add \`_meta: { progressToken: "<token>" }\` to \`tools/call\` → receive \`notifications/progress\`.

## Async (task mode)
Add \`_meta: { "modelcontextprotocol.io/task": { taskId: "<client-id>", keepAlive: <ms> } }\` to \`tools/call\`.

Lifecycle: \`submitted\` → \`working\` → \`completed\` | \`failed\` | \`cancelled\`.

Endpoints:
- \`tasks/get\` — poll for \`statusMessage\`, \`progress\`, \`total\`.
- \`tasks/result\` — retrieve final output for completed tasks.
- \`tasks/list\` — list tasks for the current session.
- \`tasks/cancel\` — cancel an active task.
- \`tasks/delete\` — remove a terminal task.

Task-linked responses and notifications include
\`_meta["io.modelcontextprotocol/related-task"] = { taskId }\`.

Notifications (opt-in via \`TASKS_STATUS_NOTIFICATIONS=true\`):
- \`notifications/tasks/created\` — emitted on task creation with related-task metadata.
- \`notifications/tasks/status\` — emitted on each status transition with related-task metadata.

HTTP mode: tasks are bound to the authenticated caller and resumable across sessions.

# Constraints
- Blocked: localhost, private IPs, link-local, cloud metadata endpoints, \`.local\`/\`.internal\` domains.
- Max HTML: ${maxHtmlSizeMb}MB. Max redirects: ${config.fetcher.maxRedirects}.
- No JS rendering — client-rendered pages may return incomplete content.
- Binary content: not supported.
- Batch JSON-RPC (\`[{...}]\`): rejected with HTTP 400.
- \`internal://\` URIs are session-scoped.
- Tasks API is experimental — endpoints may change.

# Errors

| Code | Cause | Action |
|---|---|---|
| VALIDATION_ERROR | Invalid or blocked URL | Do not retry |
| FETCH_ERROR | Network failure | Retry once with backoff |
| UPSTREAM_HTTP_ERROR | Upstream HTTP error | Retry only for 5xx |
| UPSTREAM_RATE_LIMITED | 429 from upstream | Back off, then retry |
| UPSTREAM_TIMEOUT | Upstream timed out | Retry with backoff |
| UPSTREAM_ABORTED | Request cancelled | Retry if needed |
| MCP_ERROR | Internal protocol error | Do not retry |
| queue_full | Worker pool saturated | Wait, retry, or use task mode |`;
}

function buildTopicSchema(): ReturnType<
  typeof completable<z.ZodOptional<z.ZodString>>
> {
  return completable(
    z
      .string()
      .optional()
      .describe(`Filter help to a specific topic: ${HELP_TOPICS.join(', ')}.`),
    (value) => {
      const partial = (value ?? '').toLowerCase();
      return HELP_TOPICS.filter((t) => t.startsWith(partial));
    }
  );
}

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const description =
    'Return Fetch URL server instructions: workflows, task mode, and error handling.';

  server.registerPrompt(
    'get-help',
    {
      title: 'Get Help',
      description,
      argsSchema: z.object({
        topic: buildTopicSchema(),
      }),
      ...buildOptionalIcons(iconInfo),
    },
    (args): GetPromptResult => ({
      description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: filterInstructions(instructions, args.topic),
          },
        },
      ],
    })
  );
}
