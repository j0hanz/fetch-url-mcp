# superFetch Instructions

> **Guidance for the Agent:** These instructions are available as a resource (`internal://instructions`) or prompt (`get-help`). Load them when unsure about tool usage.

## 1. Core Capability

- **Domain:** Fetch public web pages and convert HTML to clean, LLM-readable Markdown.
- **Primary Resources:** Markdown content, cached snapshots (`superfetch://cache/...`).
- **Tools:** `fetch-url` (**Read-only**; no write tools exist).

## 2. The "Golden Path" Workflows (Critical)

### Workflow A: Standard Fetch

1. Call `fetch-url` with `{ "url": "https://..." }`.
2. Read the `markdown` field from `structuredContent`.
3. **If truncated** (ends with `...[truncated]`): read the `resource_link` URI to get full content.
   > Constraint: Never guess URIs; always use the one returned.

### Workflow B: Async Execution (Large Sites / Timeouts)

1. Call `tools/call` with `task: { ttl: ... }` to start a background fetch.
2. Poll `tasks/get` until `status` is `completed` or `failed`.
3. Retrieve result via `tasks/result`.

## 3. Tool Nuances & Gotchas

- **`fetch-url`**
  - **Purpose:** Fetch a URL and return Markdown.
  - **Inputs:** `url` (required; 1–2048 chars; `https?://` only).
  - **Side effects:** None (read-only, idempotent). Populates cache automatically.
  - **Limits:** Inline content capped at 20,000 chars; larger content offloaded to `superfetch://cache/...`.
  - **Blocked targets:** `localhost`, private IPs (`10.x`, `172.16–31.x`, `192.168.x`), cloud metadata endpoints.

## 4. Error Handling Strategy

- **`VALIDATION_ERROR`:** URL invalid or blocked. **Do not retry.**
- **`FETCH_ERROR`:** Network/upstream failure. **Retry once** with backoff.
- **`queue_full`:** Worker pool busy. Wait briefly, then retry or use Task interface.

## 5. Resources

- `internal://config` — Current server limits (secrets redacted).
- `superfetch://cache/{key}` — Immutable cached snapshots. Re-fetch for fresh content.
