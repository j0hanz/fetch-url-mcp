import { config } from './config.js';
import { FETCH_URL_TOOL_NAME } from './tools.js';

export function buildServerInstructions(): string {
  const maxHtmlSizeMb = config.constants.maxHtmlSize / 1024 / 1024;
  const cacheSizeMb = config.cache.maxSizeBytes / 1024 / 1024;
  const cacheTtlHours = config.cache.ttl / 3600;

  return `<role>Web Content Extractor</role>
<task>Fetch public webpages and convert HTML to clean Markdown.</task>

<capabilities>
- Tools: \`${FETCH_URL_TOOL_NAME}\` (READ-ONLY).
- Resources: \`internal://cache/{namespace}/{hash}\` (ephemeral cached Markdown).
- Prompts: \`get-help\` (returns these instructions).
</capabilities>

<workflows>
1. Standard: Call \`${FETCH_URL_TOOL_NAME}\` -> Read \`markdown\`. If \`truncated: true\`, use \`cacheResourceUri\` with \`resources/read\` for full content.
2. Fresh: Set \`forceRefresh: true\` to bypass cache.
3. Full-Fidelity: Set \`skipNoiseRemoval: true\` to preserve nav/footers.
4. Async: Add \`task: { ttl: <ms> }\` to \`tools/call\` -> Poll \`tasks/get\` -> Call \`tasks/result\`.
</workflows>

<constraints>
- Blocked: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), metadata endpoints (169.254.169.254), .local/.internal.
- Limits: Max HTML ${maxHtmlSizeMb}MB. Max ${config.fetcher.maxRedirects} redirects.
- Cache: ${config.cache.maxKeys} entries, ${cacheSizeMb}MB, ${cacheTtlHours}h TTL.
- No JS: Client-side rendered pages may be incomplete.
- Binary: Not supported.
- Batch JSON-RPC: Array requests (\`[{...}]\`) are rejected with HTTP 400.
- Tasks API: Experimental (SDK v1.26). \`tasks/get\`, \`tasks/result\`, \`tasks/list\`, \`tasks/cancel\` may change.
- Notifications: Optional non-spec extension. Set \`TASKS_STATUS_NOTIFICATIONS=true\` to emit \`notifications/tasks/status\`.
</constraints>

<error_handling>
- VALIDATION_ERROR: Invalid/blocked URL. Do not retry.
- FETCH_ERROR: Network failure. Retry once with backoff.
- HTTP_xxx: Upstream error. Retry only for 5xx.
- ABORTED: Cancelled. Retry if needed.
- queue_full: Worker pool busy. Wait and retry, or use task mode.
</error_handling>`;
}
