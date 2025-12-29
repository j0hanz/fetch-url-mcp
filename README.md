# superFetch MCP Server

<img src="docs/logo.png" alt="SuperFetch MCP Logo" width="200">

[![npm version](https://img.shields.io/npm/v/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![Node.js](https://img.shields.io/badge/Node.js-%3E=20.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that fetches web pages, extracts readable content with Mozilla Readability, and returns AI-friendly JSONL or Markdown.

[Quick Start](#quick-start) | [How to Choose a Tool](#how-to-choose-a-tool) | [Tools](#available-tools) | [Resources](#resources) | [Configuration](#configuration) | [Security](#security) | [Development](#development)

> **Published to [MCP Registry](https://registry.modelcontextprotocol.io/)** - Search for `io.github.j0hanz/superfetch`

---

> [!CAUTION]
> This server can access URLs on behalf of AI assistants. Built-in SSRF protection blocks private IP ranges and cloud metadata endpoints, but exercise caution when deploying in sensitive environments.

## Features

| Feature            | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| Smart extraction   | Mozilla Readability removes ads, navigation, and boilerplate when enabled |
| JSONL + Markdown   | JSONL semantic blocks or clean Markdown with frontmatter                  |
| Structured blocks  | Headings, paragraphs, lists, code, tables, images, blockquotes            |
| Built-in caching   | In-memory cache with TTL, max keys, and resource subscriptions            |
| Resilient fetching | Redirect handling plus retry with exponential backoff + jitter            |
| Security first     | URL validation, SSRF/DNS/IP blocklists, header sanitization               |
| HTTP mode          | API key auth, session management, rate limiting, CORS                     |

---

## How to Choose a Tool

Use this guide to select the right tool for your web content extraction needs.

### Decision Tree

```text
Need web content for AI?
- Want structured JSONL blocks -> fetch-url (format: jsonl)
- Want clean Markdown -> fetch-markdown
- Want Markdown but also need contentBlocks count -> fetch-url (format: markdown)
```

### Quick Reference Table

| Tool             | Best For                           | Output Format                    | Use When                                  |
| ---------------- | ---------------------------------- | -------------------------------- | ----------------------------------------- |
| `fetch-url`      | Single page with structured blocks | JSONL (or Markdown via `format`) | RAG pipelines, content parsing, analytics |
| `fetch-markdown` | Single page in readable format     | Markdown + frontmatter           | Documentation, summaries, human review    |

### Common Use Cases

| Task                     | Recommended Tool                         | Why                                                  |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------- |
| Parse a blog post for AI | `fetch-url`                              | Returns semantic blocks (headings, paragraphs, code) |
| Generate documentation   | `fetch-markdown`                         | Clean markdown with frontmatter                      |
| Extract article for RAG  | `fetch-url` + `extractMainContent: true` | Removes ads/nav, keeps main content                  |

---

## Quick Start

Add superFetch to your MCP client configuration - no installation required.

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

### With Custom Configuration

Configure SuperFetch behavior by adding environment variables to the `env` property:

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "CACHE_TTL": "7200",
        "LOG_LEVEL": "debug",
        "FETCH_TIMEOUT": "60000"
      }
    }
  }
}
```

See [Configuration](#configuration) for all available options.

### Cursor

1. Open Cursor Settings
2. Go to **Features > MCP Servers**
3. Click **"+ Add new global MCP server"**
4. Add this configuration:

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

> **Tip (Windows):** If you encounter issues, try: `cmd /c "npx -y @j0hanz/superfetch@latest --stdio"`

<details>
<summary><strong>Codex IDE</strong></summary>

Add to your `~/.codex/config.toml` file:

**Basic Configuration:**

```toml
[mcp_servers.superfetch]
command = "npx"
args = ["-y", "@j0hanz/superfetch@latest", "--stdio"]
```

**With Environment Variables:**

```toml
[mcp_servers.superfetch]
command = "npx"
args = ["-y", "@j0hanz/superfetch@latest", "--stdio"]
env = { CACHE_TTL = "7200", LOG_LEVEL = "debug", FETCH_TIMEOUT = "60000" }
```

> **Access config file:** Click the gear icon -> "Codex Settings > Open config.toml"
>
> **Documentation:** [Codex MCP Guide](https://codex.com/docs/mcp)

</details>

<details>
<summary><strong>Cline (VS Code Extension)</strong></summary>

Open the Cline MCP settings file:

**macOS:**

```bash
code ~/Library/Application\ Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

**Windows:**

```bash
code %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json
```

Add the configuration:

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `./codeium/windsurf/model_config.json`:

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop (Config File Locations)</strong></summary>

**macOS:**

```bash
# Open config file
open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Or with VS Code
code "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

**Windows:**

```bash
code %APPDATA%\Claude\claude_desktop_config.json
```

</details>

---

## Installation (Alternative)

### Global Installation

```bash
npm install -g @j0hanz/superfetch

# Run in stdio mode
superfetch --stdio

# Run HTTP server (requires API_KEY)
superfetch
```

### From Source

```bash
git clone https://github.com/j0hanz/super-fetch-mcp-server.git
cd super-fetch-mcp-server
npm install
npm run build
```

### Running the Server

<details>
<summary><strong>stdio Mode</strong> (direct MCP integration)</summary>

```bash
node dist/index.js --stdio
```

</details>

<details>
<summary><strong>HTTP Mode</strong> (default)</summary>

HTTP mode requires `API_KEY` and only binds to loopback addresses unless `ALLOW_REMOTE=true`.

```bash
API_KEY=supersecret npx -y @j0hanz/superfetch@latest
# Server runs at http://127.0.0.1:3000
```

**Windows (PowerShell):**

```powershell
$env:API_KEY = "supersecret"
npx -y @j0hanz/superfetch@latest
```

Endpoints (all require `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`):

- `GET /health`
- `POST /mcp`
- `GET /mcp` (SSE stream)
- `DELETE /mcp`
- `GET /mcp/downloads/:namespace/:hash`

Sessions are managed via the `mcp-session-id` header (see [HTTP Mode Details](#http-mode-details)).

</details>

---

## Available Tools

### Tool Response Notes

Both tools return:

- `structuredContent` for machine-readable fields
- `content` blocks that include:
  - a `text` block containing JSON of `structuredContent`
  - a `resource` block with a `file:///...` URI containing the full content (stdio-friendly)
  - a `resource_link` block when content exceeds `MAX_INLINE_CONTENT_CHARS` and cache is enabled

If content is too large and cache is disabled, the server truncates output and appends `...[truncated]`.

---

### `fetch-url`

Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. You can also request Markdown with `format: "markdown"`.

| Parameter            | Type                  | Default   | Description                                   |
| -------------------- | --------------------- | --------- | --------------------------------------------- |
| `url`                | string                | required  | URL to fetch                                  |
| `format`             | "jsonl" \| "markdown" | `"jsonl"` | Output format                                 |
| `extractMainContent` | boolean               | `true`    | Use Readability to extract main content       |
| `includeMetadata`    | boolean               | `true`    | Include page metadata                         |
| `maxContentLength`   | number                | -         | Maximum content length in characters          |
| `customHeaders`      | object                | -         | Custom HTTP headers (sanitized)               |
| `timeout`            | number                | `30000`   | Request timeout in milliseconds (1000-120000) |
| `retries`            | number                | `3`       | Number of retry attempts (1-10)               |

**Example `structuredContent`:**

```json
{
  "url": "https://example.com/article",
  "title": "Example Article",
  "contentBlocks": 42,
  "fetchedAt": "2025-12-11T10:30:00.000Z",
  "format": "jsonl",
  "contentSize": 12345,
  "cached": false,
  "content": "{\"type\":\"metadata\",\"title\":\"Example Article\",\"url\":\"https://example.com/article\"}\n{\"type\":\"heading\",\"level\":1,\"text\":\"Introduction\"}"
}
```

---

### `fetch-markdown`

Fetches a webpage and converts it to clean Markdown with optional frontmatter.

| Parameter            | Type    | Default  | Description                                   |
| -------------------- | ------- | -------- | --------------------------------------------- |
| `url`                | string  | required | URL to fetch                                  |
| `extractMainContent` | boolean | `true`   | Extract main content only                     |
| `includeMetadata`    | boolean | `true`   | Include YAML frontmatter                      |
| `maxContentLength`   | number  | -        | Maximum content length in characters          |
| `customHeaders`      | object  | -        | Custom HTTP headers (sanitized)               |
| `timeout`            | number  | `30000`  | Request timeout in milliseconds (1000-120000) |
| `retries`            | number  | `3`      | Number of retry attempts (1-10)               |

**Example `structuredContent`:**

```json
{
  "url": "https://example.com/docs",
  "title": "Documentation",
  "fetchedAt": "2025-12-11T10:30:00.000Z",
  "markdown": "---\ntitle: Documentation\nsource: \"https://example.com/docs\"\n---\n\n# Getting Started\n\nWelcome...",
  "contentSize": 9876,
  "cached": false,
  "truncated": false,
  "file": {
    "downloadUrl": "/mcp/downloads/markdown/abc123def456",
    "fileName": "documentation.md",
    "expiresAt": "2025-12-11T11:30:00.000Z"
  }
}
```

`file` is included only in HTTP mode when content is cached and too large to inline.

---

### Large Content Handling

- Inline limit: `MAX_INLINE_CONTENT_CHARS` (default `20000`).
- If content exceeds the limit and cache is enabled, responses include `resourceUri` and a `resource_link` block.
- If cache is disabled, content is truncated with `...[truncated]`.
- Use `maxContentLength` per request to enforce a lower limit.

---

## Resources

| URI                                        | Description                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `superfetch://health`                      | Real-time server health and memory checks             |
| `superfetch://stats`                       | Server stats and cache metrics                        |
| `superfetch://cache/list`                  | List cached entries and their resource URIs           |
| `superfetch://cache/{namespace}/{urlHash}` | Cached content entry (`namespace`: `url`, `markdown`) |

Resource subscriptions notify clients when cache entries update.

---

## Download Endpoint (HTTP Mode)

When running in HTTP mode, cached content can be downloaded directly.

### Endpoint

```text
GET /mcp/downloads/:namespace/:hash
```

- `namespace`: `markdown` or `url`
- Auth required (`Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`)

### Response Headers

| Header                | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| `Content-Type`        | `text/markdown; charset=utf-8` or `application/x-ndjson; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="<name>"`                                         |
| `Cache-Control`       | `private, max-age=<CACHE_TTL>`                                          |

### Example Usage

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:3000/mcp/downloads/markdown/abc123.def456 \
  -o article.md
```

### Error Responses

| Status | Code                  | Description                      |
| ------ | --------------------- | -------------------------------- |
| 400    | `BAD_REQUEST`         | Invalid namespace or hash format |
| 404    | `NOT_FOUND`           | Content not found or expired     |
| 503    | `SERVICE_UNAVAILABLE` | Download service disabled        |

---

## Configuration

Configure SuperFetch behavior by adding environment variables to your MCP client configuration's `env` property.

### Fetcher Settings

| Variable        | Default              | Valid Values         | Description                     |
| --------------- | -------------------- | -------------------- | ------------------------------- |
| `FETCH_TIMEOUT` | `30000`              | `5000`-`120000`      | Request timeout in milliseconds |
| `USER_AGENT`    | `superFetch-MCP/1.0` | Any valid user agent | Custom user agent               |

### Cache Settings

| Variable         | Default | Valid Values     | Description               |
| ---------------- | ------- | ---------------- | ------------------------- |
| `CACHE_ENABLED`  | `true`  | `true` / `false` | Enable response caching   |
| `CACHE_TTL`      | `3600`  | `60`-`86400`     | Cache lifetime in seconds |
| `CACHE_MAX_KEYS` | `100`   | `10`-`1000`      | Maximum cached entries    |

### Output Settings

| Variable                   | Default | Valid Values    | Description                               |
| -------------------------- | ------- | --------------- | ----------------------------------------- |
| `MAX_INLINE_CONTENT_CHARS` | `20000` | `1000`-`200000` | Inline content limit before resource_link |

### Logging Settings

| Variable         | Default | Valid Values                        | Description            |
| ---------------- | ------- | ----------------------------------- | ---------------------- |
| `LOG_LEVEL`      | `info`  | `debug` / `info` / `warn` / `error` | Logging verbosity      |
| `ENABLE_LOGGING` | `true`  | `true` / `false`                    | Enable/disable logging |

### Extraction Settings

| Variable               | Default | Valid Values     | Description                             |
| ---------------------- | ------- | ---------------- | --------------------------------------- |
| `EXTRACT_MAIN_CONTENT` | `true`  | `true` / `false` | Use Readability to extract main content |
| `INCLUDE_METADATA`     | `true`  | `true` / `false` | Include metadata/frontmatter            |

### HTTP Server Settings

| Variable                  | Default     | Description                                  |
| ------------------------- | ----------- | -------------------------------------------- |
| `API_KEY`                 | -           | **Required for HTTP mode**                   |
| `HOST`                    | `127.0.0.1` | HTTP server host                             |
| `PORT`                    | `3000`      | HTTP server port                             |
| `ALLOW_REMOTE`            | `false`     | Allow binding to non-loopback interfaces     |
| `ALLOWED_HOSTS`           | -           | Comma-separated list of allowed Host headers |
| `TRUST_PROXY`             | `false`     | Trust proxy headers for client IP resolution |
| `SESSION_TTL_MS`          | `1800000`   | Session TTL in milliseconds (30 min)         |
| `SESSION_INIT_TIMEOUT_MS` | `10000`     | Time allowed for session initialization      |
| `MAX_SESSIONS`            | `200`       | Maximum active sessions                      |

### CORS Settings

| Variable          | Default | Description                             |
| ----------------- | ------- | --------------------------------------- |
| `ALLOWED_ORIGINS` | `[]`    | Comma-separated list of allowed origins |
| `CORS_ALLOW_ALL`  | `false` | Allow all origins (dev only)            |

### Rate Limiting

| Variable                | Default | Valid Values      | Description                          |
| ----------------------- | ------- | ----------------- | ------------------------------------ |
| `RATE_LIMIT_ENABLED`    | `true`  | `true` / `false`  | Enable/disable HTTP rate limiting    |
| `RATE_LIMIT_MAX`        | `100`   | `1`-`10000`       | Max requests per window per IP       |
| `RATE_LIMIT_WINDOW_MS`  | `60000` | `1000`-`3600000`  | Rate limit window in milliseconds    |
| `RATE_LIMIT_CLEANUP_MS` | `60000` | `10000`-`3600000` | Cleanup interval for limiter entries |

### Configuration Presets

<details open>
<summary><strong>Default (Recommended)</strong> - No configuration needed</summary>

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary><strong>Debug Mode</strong> - Verbose logging and no cache</summary>

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "LOG_LEVEL": "debug",
        "CACHE_ENABLED": "false"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Performance Mode</strong> - Aggressive caching for speed</summary>

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "CACHE_TTL": "7200",
        "CACHE_MAX_KEYS": "500",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Custom User Agent</strong> - For sites that block bots</summary>

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "USER_AGENT": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Slow Networks / CI</strong> - Extended timeouts</summary>

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "FETCH_TIMEOUT": "60000",
        "CACHE_ENABLED": "false",
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

</details>

---

## HTTP Mode Details

HTTP mode uses the MCP Streamable HTTP transport. The workflow is:

1. `POST /mcp` with an `initialize` request and **no** `mcp-session-id` header.
2. The server returns `mcp-session-id` in the response headers.
3. Use that header for subsequent `POST /mcp`, `GET /mcp`, and `DELETE /mcp` requests.

If `MAX_SESSIONS` is reached, the server evicts the oldest session when possible, otherwise returns a 503.

---

## Content Block Types

JSONL output includes semantic content blocks:

| Type         | Description                              |
| ------------ | ---------------------------------------- |
| `metadata`   | Minimal page metadata (type, title, url) |
| `heading`    | Headings (h1-h6) with level indicator    |
| `paragraph`  | Text paragraphs                          |
| `list`       | Ordered/unordered lists                  |
| `code`       | Code blocks with optional language       |
| `table`      | Tables with headers and rows             |
| `image`      | Images with src and alt text             |
| `blockquote` | Block quote text                         |

---

## Security

### SSRF Protection

Blocked destinations include:

- Localhost and loopback addresses
- Private IP ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
- Cloud metadata endpoints (AWS, GCP, Azure)
- IPv6 link-local and unique local addresses
- Internal suffixes such as `.local` and `.internal`

### URL Validation

- Only `http` and `https` URLs
- No embedded credentials in URLs
- Max URL length: 2048 characters

### Header Sanitization

Blocked headers: `host`, `authorization`, `cookie`, `x-forwarded-for`, `x-real-ip`, `proxy-authorization`

### Rate Limiting

Default: **100 requests/minute** per IP (HTTP mode only). Configure with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.

---

## Development

### Scripts

| Command                 | Description                        |
| ----------------------- | ---------------------------------- |
| `npm run dev`           | Development server with hot reload |
| `npm run build`         | Compile TypeScript                 |
| `npm start`             | Production server                  |
| `npm run lint`          | Run ESLint                         |
| `npm run type-check`    | TypeScript type checking           |
| `npm run format`        | Format with Prettier               |
| `npm test`              | Run Vitest tests                   |
| `npm run test:coverage` | Run tests with coverage            |
| `npm run bench`         | Run minimal performance benchmark  |
| `npm run release`       | Create new release                 |
| `npm run knip`          | Find unused exports/dependencies   |
| `npm run knip:fix`      | Auto-fix unused code               |

### Tech Stack

| Category           | Technology                        |
| ------------------ | --------------------------------- |
| Runtime            | Node.js >=20.12                   |
| Language           | TypeScript 5.9                    |
| MCP SDK            | @modelcontextprotocol/sdk ^1.25.1 |
| Content Extraction | @mozilla/readability ^0.6.0       |
| HTML Parsing       | Cheerio ^1.1.2, LinkeDOM ^0.18.12 |
| Markdown           | Turndown ^7.2.2                   |
| HTTP               | Express ^5.2.1, undici ^6.22.0    |
| Validation         | Zod ^3.24.1                       |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Ensure linting passes: `npm run lint`
4. Run tests: `npm test`
5. Commit changes: `git commit -m 'Add amazing feature'`
6. Push: `git push origin feature/amazing-feature`
7. Open a Pull Request

For examples of other MCP servers, see: [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
