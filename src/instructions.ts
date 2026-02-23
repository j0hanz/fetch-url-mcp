import { config } from './config.js';
import { FETCH_URL_TOOL_NAME } from './tools.js';

export function buildServerInstructions(): string {
  return `# FETCH-URL INSTRUCTIONS

Available as resource (\`internal://instructions\`) or prompt (\`get-help\`). Load when unsure about tool usage.

---

## CORE CAPABILITY

- Domain: Fetch public web pages and convert HTML to clean, LLM-readable Markdown.
- Primary Resources: Markdown content, cached snapshots (\`internal://cache/{namespace}/{hash}\`).
- Tools: \`${FETCH_URL_TOOL_NAME}\` (READ-ONLY; no write tools exist).

---

## PROMPTS

- \`get-help\`: Returns these instructions for quick recall.

---

## RESOURCES & RESOURCE LINKS

- \`internal://instructions\`: This document.
- \`internal://cache/{namespace}/{hash}\`: Ephemeral cached Markdown from previous calls. Use the \`cacheResourceUri\` from tool responses with \`resources/read\` to retrieve full content. Supports \`resources/subscribe\` for change notifications.

---

## PROGRESS & TASKS

- Include \`_meta.progressToken\` in requests to receive \`notifications/progress\` updates during fetch.
- Task-augmented tool calls are supported for \`${FETCH_URL_TOOL_NAME}\`:
  - These tools declare \`execution.taskSupport: "optional"\` — invoke normally or as a task.
  - Send \`tools/call\` with \`task\` to get a task id.
  - Poll \`tasks/get\` until status is \`completed\` or \`failed\`.
  - Use \`tasks/cancel\` to abort.
  - Task data is stored in memory and cleared on restart.

---

## THE "GOLDEN PATH" WORKFLOWS (CRITICAL)

### WORKFLOW A: STANDARD FETCH

1. Call \`${FETCH_URL_TOOL_NAME}\` with \`{ "url": "https://..." }\`.
2. Read the \`markdown\` field from \`structuredContent\`.
3. If \`truncated\` is \`true\`: use \`cacheResourceUri\` from \`structuredContent\` with \`resources/read\` to get full content.
   NOTE: Never guess URIs; always use values returned in responses.

### WORKFLOW B: FRESH CONTENT (BYPASS CACHE)

1. Call \`${FETCH_URL_TOOL_NAME}\` with \`{ "url": "https://...", "forceRefresh": true }\`.
2. Read the \`markdown\` field.
   NOTE: Use \`forceRefresh\` only when stale content is suspected. Cached responses are faster.

### WORKFLOW C: FULL-FIDELITY FETCH (PRESERVE NOISE)

1. Call \`${FETCH_URL_TOOL_NAME}\` with \`{ "url": "https://...", "skipNoiseRemoval": true }\`.
2. Read the \`markdown\` field — navigation, footers, and sidebars are preserved.
   NOTE: Use this when page structure (nav, footer) is relevant to the task.

### WORKFLOW D: ASYNC EXECUTION (LARGE SITES / TIMEOUTS)

Add \`task: { ttl: <ms> }\` to the \`tools/call\` request; poll \`tasks/get\` until \`completed\` or \`failed\`; then call \`tasks/result\`.

---

## TOOL BEHAVIOR & GOTCHAS

\`${FETCH_URL_TOOL_NAME}\`

- Purpose: Fetch a URL and return Markdown. Input/output schemas are available via MCP tool discovery.
- Side effects: None (read-only, idempotent). Populates the in-memory cache automatically.
- \`cacheResourceUri\`: Present when cache key generation succeeds; use with \`resources/read\` for full content retrieval.
- \`resolvedUrl\`: GitHub, GitLab, and Bitbucket URLs are auto-transformed to raw content endpoints. Check this field to see what was actually fetched.
- \`truncated\`: When \`true\`, inline \`markdown\` was cut to fit the inline limit. Use \`cacheResourceUri\` with \`resources/read\` for the full content.
- \`maxInlineChars\`: Set to \`0\` for unlimited inline content (default). When both a per-call and global limit exist, the lower value wins.
- Does not execute client-side JavaScript. Content requiring JS rendering may be incomplete.
- HTML capped at ${config.constants.maxHtmlSize / 1024 / 1024} MB (\`MAX_HTML_BYTES\`). Inline content unlimited by default; set \`MAX_INLINE_CONTENT_CHARS\` env var to cap.
- Error responses: read \`code\` (\`VALIDATION_ERROR\`, \`FETCH_ERROR\`, \`HTTP_xxx\`, \`ABORTED\`, \`queue_full\`) and \`statusCode\` from \`content[0]\` JSON for programmatic routing.

---

## CONSTRAINTS & LIMITATIONS

- **Blocked URLs:** localhost, private IPs (\`10.x\`, \`172.16–31.x\`, \`192.168.x\`), cloud metadata endpoints (\`169.254.169.254\`, \`metadata.google.internal\`, etc.), \`.local\`/\`.internal\` suffixes.
- **Max HTML size:** ${config.constants.maxHtmlSize / 1024 / 1024} MB per fetch.
- **Cache:** In-memory LRU — max ${config.cache.maxKeys} entries, ${config.cache.maxSizeBytes / 1024 / 1024} MB total, ${config.cache.ttl / 3600} hour TTL. Lost on process restart.
- **No JavaScript execution:** Pages relying on client-side rendering may yield incomplete Markdown.
- **Binary files:** Not supported — only HTML content is processed.
- **Redirects:** Max ${config.fetcher.maxRedirects} redirects followed automatically.

---

## ERROR HANDLING STRATEGY

Error responses include a \`code\` field for programmatic routing:

- \`VALIDATION_ERROR\`: URL invalid or blocked (private IP, metadata endpoint). Do not retry — fix the URL.
- \`FETCH_ERROR\`: Network/upstream failure (DNS, connection refused, timeout). Retry once with backoff.
- \`HTTP_{status}\` (e.g. \`HTTP_404\`, \`HTTP_500\`): Upstream returned an HTTP error. Check \`statusCode\` and \`details\` fields. Retry only for 5xx errors.
- \`ABORTED\`: Request was cancelled (timeout or task cancellation). Retry if the operation is still needed.
- \`queue_full\`: Worker pool busy (concurrent transforms). Wait briefly, then retry or use the Task interface.
`;
}
