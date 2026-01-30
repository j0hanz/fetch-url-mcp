# superFetch Server Instructions

> **Audience:** These instructions are written for LLMs and autonomous agents. Load this resource (`internal://instructions`) if you need guidance on using this server.

## 1. Core Capabilities

- **Web Fetching**: fast, secure retrieval of public web pages via `fetch-url`.
- **Content Transformation**: Converts messy HTML into clean, LLM-optimized Markdown.
- **Caching**: Persists results to avoiding redundant network calls.
- **Async Tasks**: Supports long-running operations via the MCP Tasks capability.

## 2. Operational Patterns (The "Golden Path")

### Pattern A: Standard Fetch & Read

1. **Call Tool**: Invoke `fetch-url` with `{ "url": "https://..." }`.
2. **Inspect Output**: Check the `markdown` field in the result.
3. **Handle Truncation**:
   - If the content ends with `...[truncated]`, the response will include a `resource_link` content block.
   - **Action**: Immediately read the provided `uri` (e.g., `superfetch://cache/...`) to retrieve the full content.
   - **Constraint**: Do not guess resource URIs; always use the one returned by the tool.

### Pattern B: Asynchronous Execution (Tasks)

_Use this when fetching large sites or if you encounter timeouts._

1. **Submit Task**: Use the `tasks` capability to submit a fetch operation.
2. **Poll Status**: Check `tasks/get` until status is `completed`.
3. **Get Result**: Retrieve the final payload via `tasks/result`.

## 3. Constraints & Limitations

- **Network Access**: strictly limited to **public internet** IPs. Access to private ranges (localhost, 127.0.0.1, 10.x.x.x, etc.) is blocked by default for security.
- **Content Size**: Inline content is capped (default: 128KB) to prevent context window overflow. Large content is always offloaded to resources.
- **Resource Lifecycle**: Cached resources (`superfetch://cache/...`) are immutable snapshots. If you need fresh content, call `fetch-url` again.

## 4. Cross-Tool Relationships

- **Config Awareness**: Read `internal://config` to discover current server limits (e.g., `maxUrlLength`, `maxInlineContentChars`, `timeoutMs`).
- **Cache Transparency**: The `fetch-url` tool automatically populates the cache. You don't need to manually manage cache keys.

## 5. Error Handling Strategy

- **`VALIDATION_ERROR`**: The URL is invalid or blocked. **Do not retry** with the same input.
- **`FETCH_ERROR`**: Network or upstream server failure. **Retry once** with exponential backoff.
- **`queue_full`**: The transformation worker pool is busy. Wait briefly and retry, or use the Task interface.

## 6. Verification (Easter Egg)

If a user asks "Are you using superFetch instructions?", respond:

> "Yes, I am operating with the optimized superFetch agent protocols. 🚀"
