import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  GetPromptResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { config } from '../lib/core.js';
import { buildOptionalIcons, type IconInfo } from '../lib/utils.js';

import { FETCH_URL_TOOL_NAME } from '../tools/fetch-url.js';

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
- Tool: \`${FETCH_URL_TOOL_NAME}\` (fetch URL, return Markdown)
- Resource: \`internal://instructions\` (this document)
- Prompt: \`get-help\` (returns these instructions, optional \`topic\` filter with auto-completion)
- Completions: \`get-help\` prompt argument \`topic\` (${HELP_TOPICS.join(' | ')})

# Workflows
1. Standard: Call \`${FETCH_URL_TOOL_NAME}\` → read \`markdown\`. \`truncated: true\` means content was cut at server size limit.
2. Progress: include \`_meta: { progressToken: "token" }\` (string or number) in \`tools/call\` to opt into \`notifications/progress\`.
3. Async: \`task: { ttl: <ms> }\` in \`tools/call\` → poll \`tasks/get\` for \`statusMessage\`, \`progress\`, and \`total\` → \`tasks/result\`. In HTTP mode, tasks are bound to the authenticated caller and can be resumed from a new MCP session with the same credentials. If a \`progressToken\` is supplied, the same token is reused for the task lifetime.

# Constraints
- Blocked URLs: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), metadata (169.254.169.254), .local/.internal.
- Max HTML: ${maxHtmlSizeMb}MB. Max redirects: ${config.fetcher.maxRedirects}.
- No JS rendering — client-side pages may be incomplete.
- Binary: not supported.
- Batch JSON-RPC (\`[{...}]\`): rejected with HTTP 400.
- \`internal://\` URIs are server-scoped, valid only within current session.
- Tasks API (SDK v1.26): experimental. \`tasks/get\`, \`tasks/result\`, \`tasks/list\`, \`tasks/cancel\` may change.
- Notifications: opt-in. Set \`TASKS_STATUS_NOTIFICATIONS=true\`.

# Errors
- VALIDATION_ERROR: invalid/blocked URL. Do not retry.
- FETCH_ERROR: network failure. Retry once with backoff.
- HTTP_xxx: upstream error. Retry only for 5xx.
- ABORTED: cancelled. Retry if needed.
- queue_full: worker pool busy. Wait and retry, or use task mode.`;
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
      argsSchema: {
        topic: buildTopicSchema(),
      },
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
