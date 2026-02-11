# SUPERFETCH INSTRUCTIONS

Available as resource (internal://instructions) or prompt (get-help). Load when unsure about tool usage.

---

## CORE CAPABILITY

- Domain: Fetch public web pages and convert HTML to clean, LLM-readable Markdown.
- Primary Output: Markdown content (inline; may be truncated).
- Tools: fetch-url (READ-ONLY; no write tools exist).
- Prompts: get-help.

---

## THE “GOLDEN PATH” WORKFLOWS (CRITICAL)

### WORKFLOW A: STANDARD FETCH

- Call fetch-url with: { "url": "https://..." }
- Read the “markdown” field from “structuredContent”.
- If truncated (ends with "...[truncated]"): re-run with a higher maxInlineChars or configure MAX_INLINE_CONTENT_CHARS.

### WORKFLOW B: ASYNC EXECUTION (LARGE SITES / TIMEOUTS)

- Call tools/call with task: { ttl: ... } to start a background fetch.
- Poll tasks/get until status is “completed” or “failed”.
- Retrieve result via tasks/result.

---

## TOOL NUANCES & GOTCHAS

fetch-url

- Purpose: Fetch a URL and return Markdown.
- Input: { "url": "https://..." }
- Optional: skipNoiseRemoval (bool, keeps nav/footers), forceRefresh (bool, bypasses cache), maxInlineChars (int, per-call inline limit).
- Side effects: None (read-only, idempotent). Populates cache automatically.
- Limits: HTML capped at 10 MB (MAX_HTML_BYTES). Inline content unlimited by default; set MAX_INLINE_CONTENT_CHARS globally or maxInlineChars per call.
- Blocked: localhost, private IPs (10.x, 172.16–31.x, 192.168.x), cloud metadata endpoints.
- Quality: Varies by HTML structure. Best with articles/docs. Always verify output.

---

## ERROR HANDLING STRATEGY

- VALIDATION_ERROR: URL invalid or blocked. Do not retry.
- FETCH_ERROR: Network/upstream failure. Retry once with backoff.
- queue_full: Usually handled internally by automatic fallback to in-process transform. If surfaced, retry or use Task interface.

---

## RESOURCES

- internal://instructions — This document.
- internal://cache/{namespace}/{hash} — Read cached markdown entries (typically namespace=`markdown`).
