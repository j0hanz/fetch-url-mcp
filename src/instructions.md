# SUPERFETCH INSTRUCTIONS

Available as resource (`internal://instructions`) or prompt (`get-help`). Load when unsure about tool usage.

---

## CORE CAPABILITY

- Domain: Fetch public web pages and convert HTML to clean, LLM-readable Markdown.
- Primary Resources: Markdown content, cached snapshots (`internal://cache/{namespace}/{hash}`).
- Tools: `fetch-url` (READ-ONLY; no write tools exist).

---

## PROMPTS

- `get-help`: Returns these instructions for quick recall.

---

## RESOURCES & RESOURCE LINKS

- `internal://instructions`: This document.
- `internal://cache/{namespace}/{hash}`: Immutable cached Markdown snapshots from previous `fetch-url` calls. Ephemeral — lost when the server process restarts.
- If inline Markdown is truncated (ends with `...[truncated]`), the full content may be available via the cache resource. Use `resources/read` with the cache URI to retrieve it.

---

## PROGRESS & TASKS

- Include `_meta.progressToken` in requests to receive `notifications/progress` updates during fetch.
- Task-augmented tool calls are supported for `fetch-url`:
  - These tools declare `execution.taskSupport: "optional"` — invoke normally or as a task.
  - Send `tools/call` with `task` to get a task id.
  - Poll `tasks/get` and fetch results via `tasks/result`.
  - Use `tasks/cancel` to abort.
  - Task data is stored in memory and cleared on restart.

---

## THE "GOLDEN PATH" WORKFLOWS (CRITICAL)

### WORKFLOW A: STANDARD FETCH

1. Call `fetch-url` with `{ "url": "https://..." }`.
2. Read the `markdown` field from `structuredContent`.
3. If `truncated` is `true`: use the cache resource URI or paginated access to get full content.
   NOTE: Never guess URIs; always use values returned in responses.

### WORKFLOW B: FRESH CONTENT (BYPASS CACHE)

1. Call `fetch-url` with `{ "url": "https://...", "forceRefresh": true }`.
2. Read the `markdown` field.
   NOTE: Use `forceRefresh` only when stale content is suspected. Cached responses are faster.

### WORKFLOW C: FULL-FIDELITY FETCH (PRESERVE NOISE)

1. Call `fetch-url` with `{ "url": "https://...", "skipNoiseRemoval": true }`.
2. Read the `markdown` field — navigation, footers, and sidebars are preserved.
   NOTE: Use this when page structure (nav, footer) is relevant to the task.

### WORKFLOW D: ASYNC EXECUTION (LARGE SITES / TIMEOUTS)

1. Call `tools/call` with `task: { ttl: ... }` to start a background fetch.
2. Poll `tasks/get` until status is `completed` or `failed`.
3. Retrieve result via `tasks/result`.

---

## TOOL NUANCES & GOTCHAS

`fetch-url`

- Purpose: Fetch a URL and return Markdown.
- Input: `{ url, skipNoiseRemoval?, forceRefresh?, maxInlineChars? }`
  - `url` (required): Must be `http://` or `https://`. Max 2048 chars.
  - `skipNoiseRemoval` (bool): Keeps navigation, footers, and other elements normally filtered.
  - `forceRefresh` (bool): Bypasses the cache and fetches live.
  - `maxInlineChars` (int, 0–10485760): Per-call inline limit. `0` means unlimited. If a global limit is configured, the lower value wins.
- Output: `{ url, inputUrl, resolvedUrl, finalUrl, title, metadata, markdown, fromCache, fetchedAt, contentSize, truncated, error, statusCode, details }`
  - `metadata`: Extracted page metadata — `title`, `description`, `author`, `image`, `favicon`, `publishedAt`, `modifiedAt`.
  - `markdown`: The extracted content. May be absent on error.
  - `truncated`: `true` when inline content was cut. Full content stored in cache.
  - `resolvedUrl`: The normalized/raw-transformed URL actually fetched (GitHub/GitLab/Bitbucket URLs auto-convert to raw content URLs).
  - `finalUrl`: The URL after following redirects.
- Side effects: None (read-only, idempotent). Populates the in-memory cache automatically.
- Gotcha: Inline Markdown may be truncated when `MAX_INLINE_CONTENT_CHARS` is configured. Check the `truncated` field and use the cache resource for full content.
- Gotcha: GitHub, GitLab, and Bitbucket URLs are auto-transformed to raw content endpoints. Check `resolvedUrl` to see the actual fetched URL.
- Gotcha: Does not execute client-side JavaScript. Content requiring JS rendering may be incomplete.
- Limits: HTML capped at 10 MB (`MAX_HTML_BYTES`). Inline content unlimited by default; set `MAX_INLINE_CONTENT_CHARS` env var to cap.

---

## CONSTRAINTS & LIMITATIONS

- **Blocked URLs:** localhost, private IPs (`10.x`, `172.16–31.x`, `192.168.x`), cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, etc.), `.local`/`.internal` suffixes.
- **Max HTML size:** 10 MB per fetch.
- **Cache:** In-memory LRU — max 100 entries, 50 MB total, 24-hour TTL. Lost on process restart.
- **No JavaScript execution:** Pages relying on client-side rendering may yield incomplete Markdown.
- **Binary files:** Not supported — only HTML content is processed.
- **Redirects:** Max 5 redirects followed automatically.

---

## ERROR HANDLING STRATEGY

- `VALIDATION_ERROR`: URL invalid or blocked (private IP, metadata endpoint). Do not retry — fix the URL.
- `FETCH_ERROR`: Network/upstream failure (DNS, connection refused, timeout). Retry once with backoff.
- `HTTP_{status}` (e.g. `HTTP_404`, `HTTP_500`): Upstream returned an HTTP error. Check `statusCode` and `details` fields. Retry only for 5xx errors.
- `queue_full`: Worker pool busy (concurrent transforms). Wait briefly, then retry or use the Task interface.
