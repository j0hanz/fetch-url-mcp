import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  GetPromptResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';

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

export function buildServerInstructions(): string {
  const maxHtmlSizeMb = config.constants.maxHtmlBytes / 1024 / 1024;

  return `# Fetch public webpages and return clean, readable Markdown.

# Capabilities
- Tool: \`${FETCH_URL_TOOL_NAME}\` (fetch URL, return Markdown)
- Resource: \`internal://instructions\` (this document)
- Prompt: \`get-help\` (returns these instructions)

# Workflows
1. Standard: Call \`${FETCH_URL_TOOL_NAME}\` → read \`markdown\`. \`truncated: true\` means content was cut at server size limit.
2. Async: \`task: { ttl: <ms> }\` in \`tools/call\` → poll \`tasks/get\` → \`tasks/result\`.

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
      ...buildOptionalIcons(iconInfo),
    },
    (): GetPromptResult => ({
      description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    })
  );
}
