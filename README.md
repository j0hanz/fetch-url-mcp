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

| Feature              | Description                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Smart extraction     | Mozilla Readability with quality gates to strip boilerplate when it improves results                               |
| Clean Markdown       | Markdown output with optional YAML frontmatter (title + source)                                                    |
| Raw content handling | Preserves raw markdown/text, detects common text extensions, and rewrites GitHub/GitLab/Bitbucket/Gist URLs to raw |
| Built-in caching     | In-memory cache with TTL, max keys, and resource subscriptions                                                     |
| Resilient fetching   | Redirect handling with validation, timeouts, and response size limits                                              |
| Security first       | URL validation plus SSRF/DNS/IP blocklists                                                                         |
| HTTP mode            | Static token or OAuth auth, session management, rate limiting, host/origin validation                              |

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

# Run HTTP server (requires auth token)
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

HTTP mode requires authentication. By default it binds to `127.0.0.1`. To listen on all interfaces, set `HOST=0.0.0.0` or `HOST=::` and configure OAuth (remote bindings require OAuth). Other non-loopback `HOST` values are rejected.

```bash
API_KEY=supersecret npx -y @j0hanz/superfetch@latest
# Server runs at http://127.0.0.1:3000
```

**Windows (PowerShell):**

```powershell
$env:API_KEY = "supersecret"
npx -y @j0hanz/superfetch@latest
```

For multiple static tokens, set `ACCESS_TOKENS` (comma/space separated).

Auth is required for `/mcp` and `/mcp/downloads` via `Authorization: Bearer <token>` (static mode also accepts `X-API-Key`).

Endpoints:

- `GET /health` (no auth; returns status, name, version, uptime)
- `POST /mcp` (auth required)
- `GET /mcp` (auth required; SSE stream; requires `Accept: text/event-stream`)
- `DELETE /mcp` (auth required)
- `GET /mcp/downloads/:namespace/:hash` (auth required)

Sessions are managed via the `mcp-session-id` header (see [HTTP Mode Details](#http-mode-details)).

</details>

---

## Available Tools

### Tool Response Notes

The tool returns `structuredContent` with `url`, optional `title`, and `markdown` when inline content is available. On errors, `error` is included instead of content.

The response includes:

- a `text` block containing JSON of `structuredContent`
- a `resource` block embedding markdown when inline content is available (always in stdio mode)
- when content exceeds the inline limit and cache is enabled, a `resource_link` block pointing to `superfetch://cache/...` (inline markdown may be omitted)
- error responses set `isError: true` and return `structuredContent` with `error` and `url`

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

- Inline markdown is capped at 20,000 characters (`maxInlineContentChars`).
- **Stdio mode:** full markdown is embedded as a `resource` block.
- **HTTP mode:** if content exceeds the inline limit and cache is enabled, the response includes a `resource_link` to `superfetch://cache/...` (no embedded markdown). If cache is disabled, the inline markdown is truncated with `...[truncated]`.
- Upstream fetch size is capped at 10 MB of HTML; larger responses fail.

---

## Resources

| URI                                        | Description                                    |
| ------------------------------------------ | ---------------------------------------------- |
| `superfetch://cache/{namespace}/{urlHash}` | Cached content entry (`namespace`: `markdown`) |

Resource listings enumerate cached entries, and subscriptions notify clients when cache entries update.

---

## Download Endpoint (HTTP Mode)

When running in HTTP mode, cached content can be downloaded directly. Downloads are available only when cache is enabled.

### Endpoint

```text
GET /mcp/downloads/:namespace/:hash
```

- `namespace`: `markdown`
- Auth required (`Authorization: Bearer <token>`; in static token mode, `X-API-Key` is accepted)

### Response Headers

| Header                | Value                           |
| --------------------- | ------------------------------- |
| `Content-Type`        | `text/markdown; charset=utf-8`  |
| `Content-Disposition` | `attachment; filename="<name>"` |
| `Cache-Control`       | `private, max-age=<CACHE_TTL>`  |

### Example Usage

```bash
curl -H "Authorization: Bearer $TOKEN" \
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

Set environment variables in your MCP client `env` or in the shell before starting the server.

### Core Server Settings

| Variable        | Default              | Description                                                   |
| --------------- | -------------------- | ------------------------------------------------------------- |
| `HOST`          | `127.0.0.1`          | HTTP bind address                                             |
| `PORT`          | `3000`               | HTTP server port (1024-65535)                                 |
| `USER_AGENT`    | `superFetch-MCP/2.0` | User-Agent header for outgoing requests                       |
| `CACHE_ENABLED` | `true`               | Enable response caching                                       |
| `CACHE_TTL`     | `3600`               | Cache TTL in seconds (60-86400)                               |
| `LOG_LEVEL`     | `info`               | `debug`, `info`, `warn`, `error`                              |
| `ALLOWED_HOSTS` | (empty)              | Additional allowed Host/Origin values (comma/space separated) |

### Auth (HTTP Mode)

| Variable        | Default | Description                                                  |
| --------------- | ------- | ------------------------------------------------------------ |
| `AUTH_MODE`     | auto    | `static` or `oauth`. Auto-selects OAuth if any OAUTH URL set |
| `ACCESS_TOKENS` | (empty) | Comma/space-separated static bearer tokens                   |
| `API_KEY`       | (empty) | Adds a static bearer token and enables `X-API-Key` header    |

Static mode requires at least one token (`ACCESS_TOKENS` or `API_KEY`).

### OAuth (HTTP Mode)

Required when `AUTH_MODE=oauth` (or auto-selected by presence of OAuth URLs):

| Variable                  | Default | Description            |
| ------------------------- | ------- | ---------------------- |
| `OAUTH_ISSUER_URL`        | -       | OAuth issuer           |
| `OAUTH_AUTHORIZATION_URL` | -       | Authorization endpoint |
| `OAUTH_TOKEN_URL`         | -       | Token endpoint         |
| `OAUTH_INTROSPECTION_URL` | -       | Introspection endpoint |

Optional:

| Variable                         | Default                    | Description                             |
| -------------------------------- | -------------------------- | --------------------------------------- |
| `OAUTH_REVOCATION_URL`           | -                          | Revocation endpoint                     |
| `OAUTH_REGISTRATION_URL`         | -                          | Dynamic client registration endpoint    |
| `OAUTH_RESOURCE_URL`             | `http://<host>:<port>/mcp` | Protected resource URL                  |
| `OAUTH_REQUIRED_SCOPES`          | (empty)                    | Required scopes (comma/space separated) |
| `OAUTH_CLIENT_ID`                | -                          | Client ID for introspection             |
| `OAUTH_CLIENT_SECRET`            | -                          | Client secret for introspection         |
| `OAUTH_INTROSPECTION_TIMEOUT_MS` | `5000`                     | Introspection timeout (1000-30000)      |

### Fixed Limits (Not Configurable via env)

- Fetch timeout: 15 seconds
- Max redirects: 5
- Max HTML response size: 10 MB
- Inline markdown limit: 20,000 characters
- Cache max entries: 100
- Session TTL: 30 minutes
- Session init timeout: 10 seconds
- Max sessions: 200
- Rate limit: 100 req/min per IP (60s window)

See `CONFIGURATION.md` for preset examples and quick-start snippets.

---

## HTTP Mode Details

HTTP mode uses the MCP Streamable HTTP transport. The workflow is:

1. `POST /mcp` with an `initialize` request and **no** `mcp-session-id` header.
2. The server returns `mcp-session-id` in the response headers.
3. Use that header for subsequent `POST /mcp`, `GET /mcp`, and `DELETE /mcp` requests.

If the `mcp-protocol-version` header is missing, the server defaults it to `2025-03-26`. Supported versions are `2025-03-26` and `2025-11-25`.

`GET /mcp` and `DELETE /mcp` require `mcp-session-id`. `POST /mcp` without an `initialize` request will return 400.

Additional HTTP transport notes:

- `GET /mcp` requires `Accept: text/event-stream` (otherwise 406).
- JSON-RPC batch requests are not supported (400).

If the server reaches its session cap (200), it evicts the oldest session when possible; otherwise it returns a 503.

Host and Origin headers are always validated. Allowed values include loopback hosts, the configured `HOST` (if not a wildcard), and any entries in `ALLOWED_HOSTS`. When binding to `0.0.0.0` or `::`, set `ALLOWED_HOSTS` to the hostnames clients will send.

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

### Host/Origin Validation (HTTP Mode)

- Host header must match loopback, configured `HOST` (if not a wildcard), or `ALLOWED_HOSTS`
- Origin header (when present) is validated against the same allow-list

### Rate Limiting

Rate limiting applies to `/mcp` and `/mcp/downloads` (100 req/min per IP, 60s window). OPTIONS requests are not rate-limited.

---

## Development

### Scripts

| Command                 | Description                          |
| ----------------------- | ------------------------------------ |
| `npm run dev`           | Development server with hot reload   |
| `npm run build`         | Compile TypeScript                   |
| `npm start`             | Production server                    |
| `npm run lint`          | Run ESLint                           |
| `npm run lint:fix`      | Auto-fix lint issues                 |
| `npm run type-check`    | TypeScript type checking             |
| `npm run format`        | Format with Prettier                 |
| `npm test`              | Run Node test runner (builds dist)   |
| `npm run test:coverage` | Run tests with experimental coverage |
| `npm run knip`          | Find unused exports/dependencies     |
| `npm run knip:fix`      | Auto-fix unused code                 |
| `npm run inspector`     | Launch MCP Inspector                 |

> **Note:** Tests run via `node --test` with `--experimental-transform-types` to execute `.ts` test files. Node will emit an experimental warning.

### Tech Stack

| Category           | Technology                        |
| ------------------ | --------------------------------- |
| Runtime            | Node.js >=20.12                   |
| Language           | TypeScript 5.9                    |
| MCP SDK            | @modelcontextprotocol/sdk ^1.25.2 |
| Content Extraction | @mozilla/readability ^0.6.0       |
| HTML Parsing       | linkedom ^0.18.12                 |
| Markdown           | Turndown ^7.2.2                   |
| HTTP               | Express ^5.2.1, undici ^6.23.0    |
| Validation         | Zod ^4.3.5                        |

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
