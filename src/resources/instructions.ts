import { config } from '../lib/core.js';

import { FETCH_URL_TOOL_NAME } from '../tools/fetch-url.js';

export function buildServerInstructions(): string {
  const maxHtmlSizeMb = config.constants.maxHtmlSize / 1024 / 1024;
  const cacheSizeMb = config.cache.maxSizeBytes / 1024 / 1024;
  const cacheTtlHours = config.cache.ttl / 3600;

  return `# Fetch public webpages and return clean, readable Markdown.

# Capabilities
- Tool: \`${FETCH_URL_TOOL_NAME}\` (fetch URL, return Markdown)
- Resource: \`internal://instructions\` (this document)
- Resource template: \`internal://cache/{namespace}/{hash}\` (cached Markdown)
- Prompt: \`get-help\` (returns these instructions)
- Completions: resource-template argument completion for cache entries

# Workflows
1. Standard: Call \`${FETCH_URL_TOOL_NAME}\` → read \`markdown\`. \`truncated: true\` means content was cut at server size limit.
2. Fresh: \`forceRefresh: true\` bypasses cache (does not fix truncation).
3. Async: \`task: { ttl: <ms> }\` in \`tools/call\` → poll \`tasks/get\` → \`tasks/result\`.

# Constraints
- Blocked URLs: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), metadata (169.254.169.254), .local/.internal.
- Max HTML: ${maxHtmlSizeMb}MB. Max redirects: ${config.fetcher.maxRedirects}.
- Cache: ${config.cache.maxKeys} entries, ${cacheSizeMb}MB, ${cacheTtlHours}h TTL. Process-local, ephemeral.
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
