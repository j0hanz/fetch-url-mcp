# SUPERFETCH INSTRUCTIONS

These instructions are available as a resource (internal://instructions) or prompt (get-help). Load them when unsure about tool usage.

---

## CORE CAPABILITY

- Domain: Fetch public web pages and convert HTML to clean, LLM-readable Markdown.
- Primary Resources: Markdown content, cached snapshots (superfetch://cache/...).
- Tools: fetch-url (READ-ONLY; no write tools exist).

---

## THE “GOLDEN PATH” WORKFLOWS (CRITICAL)

### WORKFLOW A: STANDARD FETCH

- Call fetch-url with: { "url": "https://..." }
- Read the “markdown” field from “structuredContent”.
- If truncated (ends with “…[truncated]”): read the “resource_link” URI to get full content.
  NOTE: Never guess URIs; always use the one returned.

### WORKFLOW B: ASYNC EXECUTION (LARGE SITES / TIMEOUTS)

- Call tools/call with task: { ttl: ... } to start a background fetch.
- Poll tasks/get until status is “completed” or “failed”.
- Retrieve result via tasks/result.

---

## TOOL NUANCES & GOTCHAS

fetch-url

- Purpose: Fetch a URL and return Markdown.
- Input: { "url": "https://..." }
- Side effects: None (read-only, idempotent). Populates cache automatically.
- Limits: Inline content capped at 20,000 chars; larger content offloaded to superfetch://cache/....
- Blocked targets: localhost, private IPs (10.x, 172.16–31.x, 192.168.x), cloud metadata endpoints.
- Content quality: Extraction quality varies by HTML structure. Works best with standard articles/docs. Always verify output.

---

## ERROR HANDLING STRATEGY

- VALIDATION_ERROR: URL invalid or blocked. Do not retry.
- FETCH_ERROR: Network/upstream failure. Retry once with backoff.
- queue_full: Worker pool busy. Wait briefly, then retry or use Task interface.

---

## RESOURCES

- internal://config — Current server limits (secrets redacted).
- superfetch://cache/{key} — Immutable cached snapshots. Re-fetch for fresh content.
