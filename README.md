<!-- markdownlint-disable MD033 -->

# superFetch MCP Server

Intelligent web content fetcher MCP server that converts HTML to clean, AI-readable Markdown.

[![npm version](https://img.shields.io/npm/v/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![license](https://img.shields.io/npm/l/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![Node.js](https://img.shields.io/badge/Node.js-%3E=20.18.1-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.25.x-6f42c1)](https://github.com/modelcontextprotocol/sdk)

<img src="docs/logo.png" alt="SuperFetch MCP Logo" width="300">

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D)
[![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

## Overview

| Feature              | Details                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| HTML → Markdown      | Mozilla Readability + node-html-markdown pipeline with metadata injection. |
| Raw content handling | Rewrites supported GitHub/GitLab/Bitbucket/Gist URLs to raw content.       |
| Caching + resources  | LRU cache with resource listing and update notifications.                  |
| Transport            | Stdio (local clients) and Streamable HTTP (self-hosted).                   |
| Safety               | SSRF/IP blocklists, Host/Origin validation, auth for HTTP mode.            |

### When to use

- You need clean, AI-friendly Markdown from public http(s) URLs.
- You want a single MCP tool that handles fetching, extraction, and caching.
- You need self-hosted HTTP with auth and session management.

## Quick Start

Recommended for MCP clients: stdio mode.

```bash
npx -y @j0hanz/superfetch@latest --stdio
```

Example MCP client configuration:

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

## Installation

### NPX (recommended)

```bash
npx -y @j0hanz/superfetch@latest --stdio
```

### Global install

```bash
npm install -g @j0hanz/superfetch
superfetch --stdio
```

### From source

```bash
git clone https://github.com/j0hanz/super-fetch-mcp-server.git
cd super-fetch-mcp-server
npm install
npm run build
node dist/index.js --stdio
```

## Configuration

### CLI arguments

| Argument  | Type    | Default | Description                         |
| --------- | ------- | ------- | ----------------------------------- |
| `--stdio` | boolean | false   | Run in stdio mode (no HTTP server). |

### Environment variables

#### Core server settings

| Variable                           | Default              | Description                                                    |
| ---------------------------------- | -------------------- | -------------------------------------------------------------- |
| `HOST`                             | `127.0.0.1`          | HTTP bind address.                                             |
| `PORT`                             | `3000`               | HTTP server port (1024-65535, `0` for ephemeral).              |
| `USER_AGENT`                       | `superFetch-MCP/2.0` | User-Agent header for outgoing requests.                       |
| `CACHE_ENABLED`                    | `true`               | Enable response caching.                                       |
| `CACHE_TTL`                        | `3600`               | Cache TTL in seconds (60-86400).                               |
| `LOG_LEVEL`                        | `info`               | Logging level (`debug` enables verbose logs).                  |
| `ALLOW_REMOTE`                     | `false`              | Allow non-loopback binds (OAuth required).                     |
| `ALLOWED_HOSTS`                    | (empty)              | Additional allowed Host/Origin values (comma/space separated). |
| `TRANSFORM_TIMEOUT_MS`             | `30000`              | Worker transform timeout in ms (5000-120000).                  |
| `TOOL_TIMEOUT_MS`                  | `50000`              | Overall tool timeout in ms (1000-300000).                      |
| `TRANSFORM_METADATA_FORMAT`        | `markdown`           | Metadata format: `markdown` or `frontmatter`.                  |
| `SUPERFETCH_EXTRA_NOISE_TOKENS`    | (empty)              | Extra noise tokens for DOM noise removal.                      |
| `SUPERFETCH_EXTRA_NOISE_SELECTORS` | (empty)              | Extra CSS selectors for DOM noise removal.                     |

#### HTTP server tuning (optional)

| Variable                       | Default | Description                                   |
| ------------------------------ | ------- | --------------------------------------------- |
| `SERVER_HEADERS_TIMEOUT_MS`    | (unset) | Sets `server.headersTimeout` (1000-600000).   |
| `SERVER_REQUEST_TIMEOUT_MS`    | (unset) | Sets `server.requestTimeout` (1000-600000).   |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS` | (unset) | Sets `server.keepAliveTimeout` (1000-600000). |
| `SERVER_SHUTDOWN_CLOSE_IDLE`   | `false` | Close idle connections on shutdown.           |
| `SERVER_SHUTDOWN_CLOSE_ALL`    | `false` | Close all connections on shutdown.            |

#### Auth (HTTP mode)

| Variable        | Default | Description                                          |
| --------------- | ------- | ---------------------------------------------------- |
| `AUTH_MODE`     | auto    | `static` or `oauth` (auto-detected from OAuth URLs). |
| `ACCESS_TOKENS` | (empty) | Comma/space-separated static bearer tokens.          |
| `API_KEY`       | (empty) | Adds a static bearer token and enables `X-API-Key`.  |

Static mode requires at least one token (`ACCESS_TOKENS` or `API_KEY`).

#### OAuth (HTTP mode)

Required when `AUTH_MODE=oauth` (or auto-selected by OAuth URLs):

| Variable                  | Default | Description             |
| ------------------------- | ------- | ----------------------- |
| `OAUTH_ISSUER_URL`        | -       | OAuth issuer.           |
| `OAUTH_AUTHORIZATION_URL` | -       | Authorization endpoint. |
| `OAUTH_TOKEN_URL`         | -       | Token endpoint.         |
| `OAUTH_INTROSPECTION_URL` | -       | Introspection endpoint. |

Optional:

| Variable                         | Default                    | Description                              |
| -------------------------------- | -------------------------- | ---------------------------------------- |
| `OAUTH_REVOCATION_URL`           | -                          | Revocation endpoint.                     |
| `OAUTH_REGISTRATION_URL`         | -                          | Dynamic client registration endpoint.    |
| `OAUTH_RESOURCE_URL`             | `http://<host>:<port>/mcp` | Protected resource URL.                  |
| `OAUTH_REQUIRED_SCOPES`          | (empty)                    | Required scopes (comma/space separated). |
| `OAUTH_CLIENT_ID`                | -                          | Client ID for introspection.             |
| `OAUTH_CLIENT_SECRET`            | -                          | Client secret for introspection.         |
| `OAUTH_INTROSPECTION_TIMEOUT_MS` | `5000`                     | Introspection timeout (1000-30000).      |

### HTTP mode endpoints

| Method | Path                              | Auth | Notes                                              |
| ------ | --------------------------------- | ---- | -------------------------------------------------- |
| GET    | `/health`                         | No   | Health check.                                      |
| POST   | `/mcp`                            | Yes  | Streamable HTTP JSON-RPC requests.                 |
| GET    | `/mcp`                            | Yes  | SSE stream (requires `Accept: text/event-stream`). |
| DELETE | `/mcp`                            | Yes  | Close the session.                                 |
| GET    | `/mcp/downloads/:namespace/:hash` | Yes  | Download cached markdown.                          |

Sessions are managed via the `mcp-session-id` header. A `POST /mcp` `initialize` request creates a session and returns the session id.

## API Reference

### Tools

#### `fetch-url`

Fetches a webpage and converts it to clean Markdown.

##### Parameters

| Name  | Type   | Required | Default | Description                          |
| ----- | ------ | -------- | ------- | ------------------------------------ |
| `url` | string | Yes      | -       | Public http(s) URL, max length 2048. |

##### Returns

`structuredContent` fields:

- `url` (string): fetched URL
- `inputUrl` (string, optional): original input URL
- `resolvedUrl` (string, optional): normalized or raw-content URL
- `title` (string, optional): page title
- `markdown` (string, optional): markdown content (inline when available)
- `error` (string, optional): error message on failure

##### Example success

```json
{
  "url": "https://example.com/docs",
  "inputUrl": "https://example.com/docs",
  "resolvedUrl": "https://example.com/docs",
  "title": "Example Docs",
  "markdown": "# Getting Started\n\n..."
}
```

##### Example error

```json
{
  "url": "https://example.com/404",
  "error": "Failed to fetch URL: 404 Not Found"
}
```

##### Large content handling

- Inline markdown is capped at 20,000 characters.
- When content exceeds the inline limit and cache is enabled, responses include a `resource_link` to `superfetch://cache/markdown/{urlHash}`.
- If cache is disabled, inline content is truncated with `...[truncated]`.

### Resources

| URI pattern                             | Description                    | MIME type       |
| --------------------------------------- | ------------------------------ | --------------- |
| `superfetch://cache/markdown/{urlHash}` | Cached markdown content entry. | `text/markdown` |
| `internal://instructions`               | Server usage instructions.     | `text/markdown` |

### Prompts

No prompts are registered in this server.

## Client Configuration Examples

<details>
<summary><strong>VS Code</strong></summary>

Add to .vscode/mcp.json:

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
<summary><strong>Claude Desktop</strong></summary>

Add to claude_desktop_config.json:

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
<summary><strong>Cursor</strong></summary>

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
<summary><strong>Windsurf</strong></summary>

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

## Security

- Stdio logs are written to stderr (stdout is reserved for MCP traffic).
- HTTP mode validates Host and Origin headers against allowed hosts.
- HTTP mode requires `MCP-Protocol-Version: 2025-11-25`.
- Auth is required for HTTP mode (static tokens or OAuth).
- SSRF protections block private IP ranges and common metadata endpoints.
- Rate limiting: 100 requests/minute per IP (60s window) for HTTP routes.

## Development

### Prerequisites

- Node.js >= 20.18.1
- npm

### Scripts

| Script                 | Command                                                                                                                             | Purpose                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| clean                  | `node scripts/clean.mjs`                                                                                                            | Remove build artifacts.            |
| validate:instructions  | `node scripts/validate-instructions.mjs`                                                                                            | Validate embedded instructions.    |
| build                  | `npm run clean && tsc -p tsconfig.json && npm run validate:instructions && npm run copy:assets && node scripts/make-executable.mjs` | Build the server.                  |
| copy:assets            | `node scripts/copy-assets.mjs`                                                                                                      | Copy static assets.                |
| prepare                | `npm run build`                                                                                                                     | Prepare package for publishing.    |
| dev                    | `tsc --watch --preserveWatchOutput`                                                                                                 | TypeScript watch mode.             |
| dev:run                | `node --watch dist/index.js`                                                                                                        | Run compiled server in watch mode. |
| start                  | `node dist/index.js`                                                                                                                | Start HTTP server (default).       |
| format                 | `prettier --write .`                                                                                                                | Format codebase.                   |
| type-check             | `tsc --noEmit`                                                                                                                      | Type checking.                     |
| type-check:diagnostics | `tsc --noEmit --extendedDiagnostics`                                                                                                | Type check diagnostics.            |
| type-check:trace       | `tsc --noEmit --generateTrace .ts-trace`                                                                                            | Generate TS trace.                 |
| lint                   | `eslint .`                                                                                                                          | Lint.                              |
| lint:fix               | `eslint . --fix`                                                                                                                    | Lint and fix.                      |
| test                   | `npm run build --silent && node --test --experimental-transform-types`                                                              | Run tests (builds first).          |
| test:coverage          | `npm run build --silent && node --test --experimental-transform-types --experimental-test-coverage`                                 | Test with coverage.                |
| knip                   | `knip`                                                                                                                              | Dead code analysis.                |
| knip:fix               | `knip --fix`                                                                                                                        | Fix knip issues.                   |
| inspector              | `npx @modelcontextprotocol/inspector`                                                                                               | MCP Inspector.                     |
| prepublishOnly         | `npm run lint && npm run type-check && npm run build`                                                                               | Prepublish checks.                 |

### Project structure

```text
superFetch
├── docs
│   └── logo.png
├── src
│   ├── workers
│   ├── cache.ts
│   ├── config.ts
│   ├── fetch.ts
│   ├── http-native.ts
│   ├── http-utils.ts
│   ├── index.ts
│   ├── instructions.md
│   ├── mcp.ts
│   ├── tools.ts
│   ├── transform.ts
│   └── ...
├── tests
│   └── *.test.ts
├── CONFIGURATION.md
├── package.json
└── tsconfig.json
```

<!-- markdownlint-enable MD033 -->
