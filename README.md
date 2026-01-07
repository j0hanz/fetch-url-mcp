# superFetch MCP Server

<img src="docs/logo.png" alt="SuperFetch MCP Logo" width="200">

[![npm version](https://img.shields.io/npm/v/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![Node.js](https://img.shields.io/badge/Node.js-%3E=20.12-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that fetches web pages, extracts readable content with Mozilla Readability, and returns AI-friendly Markdown.

[Quick Start](#quick-start) | [Tool](#available-tools) | [Resources](#resources) | [Configuration](#configuration) | [Security](#security) | [Development](#development)

> **Published to [MCP Registry](https://registry.modelcontextprotocol.io/)** - Search for `io.github.j0hanz/superfetch`

---

> [!CAUTION]
> This server can access URLs on behalf of AI assistants. Built-in SSRF protection blocks private IP ranges and cloud metadata endpoints, but exercise caution when deploying in sensitive environments.

## Features

| Feature            | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| Smart extraction   | Mozilla Readability removes ads, navigation, and boilerplate when enabled |
| Clean Markdown     | Clean Markdown output with YAML frontmatter                               |
| Built-in caching   | In-memory cache with TTL, max keys, and resource subscriptions            |
| Resilient fetching | Redirect handling with security validation                                |
| Security first     | URL validation, SSRF/DNS/IP blocklists, header sanitization               |
| HTTP mode          | API key auth, session management, rate limiting, CORS                     |

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

Add environment variables in your MCP client config under `env`.
See [Configuration](#configuration) or `CONFIGURATION.md` for all available options and presets.

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

**With Environment Variables:** See `CONFIGURATION.md` for examples.

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

The tool returns a minimal `structuredContent` with just `url`, `title`, and `markdown`. On errors, `error` is included instead of content.

The response includes:

- a `text` block containing JSON of `structuredContent`
- a `resource` block embedding the full content with a `file:///...` URI
- in HTTP mode when content exceeds `MAX_INLINE_CONTENT_CHARS`, a `resource_link` block pointing to `superfetch://cache/...`

---

### `fetch-url`

Fetches a webpage and converts it to clean Markdown format with optional frontmatter.

| Parameter | Type   | Default  | Description  |
| --------- | ------ | -------- | ------------ |
| `url`     | string | required | URL to fetch |

**Example `structuredContent`:**

```json
{
  "url": "https://example.com/docs",
  "title": "Documentation",
  "markdown": "---\ntitle: Documentation\n---\n\n# Getting Started\n\nWelcome..."
}
```

**Error response:**

```json
{
  "url": "https://example.com/broken",
  "error": "Failed to fetch: 404 Not Found"
}
```

---

### Large Content Handling

- Content is always fully embedded as a resource block in the response.
- In HTTP mode, a `resource_link` block is added when content exceeds `MAX_INLINE_CONTENT_CHARS`.
- Upstream fetch size is capped at 10 MB of HTML; larger responses fail.

---

## Resources

| URI                                        | Description                                    |
| ------------------------------------------ | ---------------------------------------------- |
| `superfetch://health`                      | Real-time server health and memory checks      |
| `superfetch://stats`                       | Server stats and cache metrics                 |
| `superfetch://cache/list`                  | List cached entries and their resource URIs    |
| `superfetch://cache/{namespace}/{urlHash}` | Cached content entry (`namespace`: `markdown`) |

Resource subscriptions notify clients when cache entries update.

---

## Download Endpoint (HTTP Mode)

When running in HTTP mode, cached content can be downloaded directly. Downloads are available only when cache is enabled.

### Endpoint

```text
GET /mcp/downloads/:namespace/:hash
```

- `namespace`: `markdown`
- Auth required (`Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`)

### Response Headers

| Header                | Value                           |
| --------------------- | ------------------------------- |
| `Content-Type`        | `text/markdown; charset=utf-8`  |
| `Content-Disposition` | `attachment; filename="<name>"` |
| `Cache-Control`       | `private, max-age=<CACHE_TTL>`  |

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

Configuration details live in `CONFIGURATION.md`, including all environment variables, defaults, ranges, presets, and dev-only flags.

---

## HTTP Mode Details

HTTP mode uses the MCP Streamable HTTP transport. The workflow is:

1. `POST /mcp` with an `initialize` request and **no** `mcp-session-id` header.
2. The server returns `mcp-session-id` in the response headers.
3. Use that header for subsequent `POST /mcp`, `GET /mcp`, and `DELETE /mcp` requests.

`GET /mcp` and `DELETE /mcp` require `mcp-session-id`. `POST /mcp` without an `initialize` request will return 400.

If `MAX_SESSIONS` is reached, the server evicts the oldest session when possible, otherwise returns a 503.

Host header validation is always enforced in HTTP mode. When binding to `0.0.0.0` or `::`, set `ALLOWED_HOSTS` to the hostnames clients will send. If an `Origin` header is present, it must be allowed by `ALLOWED_ORIGINS` or `CORS_ALLOW_ALL`.

---

## Security

### SSRF Protection

Blocked destinations include:

- Loopback and unspecified addresses (`127.0.0.0/8`, `::1`, `0.0.0.0`, `::`)
- Private/ULA ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`)
- Link-local and shared address space (`169.254.0.0/16`, `100.64.0.0/10`, `fe80::/10`)
- Multicast/reserved ranges (`224.0.0.0/4`, `240.0.0.0/4`, `ff00::/8`)
- IPv6 transition ranges (`64:ff9b::/96`, `64:ff9b:1::/48`, `2001::/32`, `2002::/16`)
- Cloud metadata endpoints (AWS/GCP/Azure/Alibaba) like `169.254.169.254`, `metadata.google.internal`, `metadata.azure.com`, `100.100.100.200`, `instance-data`
- Internal suffixes such as `.local` and `.internal`

DNS resolution is performed and blocked if any resolved IP matches a blocked range.

### URL Validation

- Only `http` and `https` URLs
- No embedded credentials in URLs
- Max URL length: 2048 characters
- Hostnames ending in `.local` or `.internal` are rejected

### Header Sanitization

Blocked headers: `host`, `authorization`, `cookie`, `x-forwarded-for`, `x-real-ip`, `proxy-authorization`

### Rate Limiting

Rate limiting applies to `/mcp` and `/mcp/downloads` and is configurable via `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, and `RATE_LIMIT_CLEANUP_MS` (see `CONFIGURATION.md`).

---

## Development

### Scripts

| Command                 | Description                          |
| ----------------------- | ------------------------------------ |
| `npm run dev`           | Development server with hot reload   |
| `npm run build`         | Compile TypeScript                   |
| `npm start`             | Production server                    |
| `npm run lint`          | Run ESLint                           |
| `npm run type-check`    | TypeScript type checking             |
| `npm run format`        | Format with Prettier                 |
| `npm test`              | Run Node test runner (builds dist)   |
| `npm run test:coverage` | Run tests with experimental coverage |
| `npm run knip`          | Find unused exports/dependencies     |
| `npm run knip:fix`      | Auto-fix unused code                 |

> **Note:** Tests run via `node --test` with `--experimental-transform-types` to execute `.ts` test files. Node will emit an experimental warning.

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
| Validation         | Zod ^4.3.4                        |

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
