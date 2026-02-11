<!-- markdownlint-disable MD033 -->

# SuperFetch MCP Server

<img src="assets/logo.svg" alt="SuperFetch MCP Logo" width="300">

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Fsuperfetch)](https://www.npmjs.com/package/@j0hanz/superfetch) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.26-purple)](https://modelcontextprotocol.io)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0078d7?logo=visual-studio-code&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22superfetch%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?logo=visual-studio-code&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%7B%22name%22%3A%22superfetch%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install-f97316?logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

Fetch and convert public web content to clean Markdown both readable by humans and optimized for LLM context.

## Overview

superFetch is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that fetches public web pages, extracts meaningful content using Mozilla's Readability algorithm, and converts the result into clean Markdown optimized for LLM context windows. It handles noise removal, caching, SSRF protection, async task execution, and supports both stdio and Streamable HTTP transports.

## Key Features

- HTML to Markdown using Mozilla Readability + node-html-markdown.
- Raw content URL rewriting for GitHub, GitLab, Bitbucket, and Gist.
- In-memory LRU cache exposed as MCP resources and HTTP download endpoints.
- Stdio or Streamable HTTP transport with session management.
- SSRF protections: blocked private IP ranges and internal hostnames.

> **Note:** Content extraction quality varies depending on the HTML structure and
> complexity of the source page. SuperFetch works best with standard article and
> documentation layouts. Always verify the fetched content to ensure it meets
> your expectations, as some pages may require manual adjustment or alternative
> approaches.

## Tech Stack

| Component           | Technology                          |
| ------------------- | ----------------------------------- |
| Runtime             | Node.js ≥ 24                        |
| Language            | TypeScript 5.9                      |
| MCP SDK             | `@modelcontextprotocol/sdk` ^1.26.0 |
| Content Extraction  | `@mozilla/readability` ^0.6.0       |
| DOM Parsing         | `linkedom` ^0.18.12                 |
| Markdown Conversion | `node-html-markdown` ^2.0.0         |
| Schema Validation   | `zod` ^4.3.6                        |
| Package Manager     | npm                                 |

## Architecture

```text
URL → Validate → DNS Preflight → HTTP Fetch → Decompress
  → Truncate HTML → Readability Extract → Noise Removal
  → Markdown Convert → Cleanup Pipeline → Cache → Response
```

1. **URL Validation** — Normalize, block private hosts, transform raw-content URLs (GitHub, GitLab, Bitbucket)
2. **Fetch** — HTTP request via `undici` with redirect following, DNS preflight SSRF checks, and size limits
3. **Transform** — Offloaded to worker threads: parse HTML with `linkedom`, extract with Readability, remove DOM noise, convert to Markdown
4. **Cleanup** — Multi-pass Markdown normalization (heading promotion, spacing, skip-link removal, TypeDoc comment stripping)
5. **Cache + Respond** — Store result, apply inline content limits, return structured content with optional resource links

## Repository Structure

```text
superFetch/
├── assets/
│   └── logo.svg
├── scripts/
│   ├── tasks.mjs
│   └── validate-fetch.mjs
├── src/
│   ├── workers/
│   │   ├── transform-child.ts
│   │   └── transform-worker.ts
│   ├── cache.ts
│   ├── config.ts
│   ├── crypto.ts
│   ├── dom-noise-removal.ts
│   ├── errors.ts
│   ├── fetch.ts
│   ├── host-normalization.ts
│   ├── http-native.ts
│   ├── index.ts
│   ├── instructions.md
│   ├── ip-blocklist.ts
│   ├── json.ts
│   ├── language-detection.ts
│   ├── markdown-cleanup.ts
│   ├── mcp-validator.ts
│   ├── mcp.ts
│   ├── observability.ts
│   ├── resources.ts
│   ├── server-tuning.ts
│   ├── session.ts
│   ├── tasks.ts
│   ├── timer-utils.ts
│   ├── tools.ts
│   ├── transform-types.ts
│   ├── transform.ts
│   └── type-guards.ts
├── tests/
│   └── *.test.ts
├── package.json
├── tsconfig.json
└── AGENTS.md
```

## Requirements

- **Node.js** ≥ 24

## Quickstart

```bash
npx -y @j0hanz/superfetch@latest --stdio
```

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "superfetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

## Installation

### NPX (Recommended)

No installation required — runs directly:

```bash
npx -y @j0hanz/superfetch@latest --stdio
```

### Global Install

```bash
npm install -g @j0hanz/superfetch
superfetch --stdio
```

### From Source

```bash
git clone https://github.com/j0hanz/super-fetch-mcp-server.git
cd super-fetch-mcp-server
npm install
npm run build
node dist/index.js --stdio
```

## Configuration

### Runtime Modes

| Flag        | Description                                 |
| ----------- | ------------------------------------------- |
| `--stdio`   | Run in stdio mode (for desktop MCP clients) |
| `--help`    | Show usage help                             |
| `--version` | Print server version                        |

When no `--stdio` flag is passed, the server starts in **HTTP mode** (Streamable HTTP on port 3000 by default).

### Environment Variables

#### Core Settings

| Variable           | Default                    | Description                                            |
| ------------------ | -------------------------- | ------------------------------------------------------ |
| `HOST`             | `127.0.0.1`                | HTTP server bind address                               |
| `PORT`             | `3000`                     | HTTP server port (1024–65535)                          |
| `LOG_LEVEL`        | `info`                     | Log level: `debug`, `info`, `warn`, `error`            |
| `FETCH_TIMEOUT_MS` | `15000`                    | HTTP fetch timeout in ms (1000–60000)                  |
| `CACHE_ENABLED`    | `true`                     | Enable/disable in-memory content cache                 |
| `USER_AGENT`       | `superFetch-MCP/{version}` | Custom User-Agent header                               |
| `ALLOW_REMOTE`     | `false`                    | Allow remote connections in HTTP mode                  |
| `ALLOWED_HOSTS`    | _(empty)_                  | Comma-separated hostnames allowed to bypass block list |

#### Authentication (HTTP Mode)

| Variable                  | Default   | Description                             |
| ------------------------- | --------- | --------------------------------------- |
| `ACCESS_TOKENS`           | _(empty)_ | Comma-separated static bearer tokens    |
| `API_KEY`                 | _(empty)_ | Single API key (added to static tokens) |
| `OAUTH_ISSUER_URL`        | _(empty)_ | OAuth issuer URL (enables OAuth mode)   |
| `OAUTH_AUTHORIZATION_URL` | _(empty)_ | OAuth authorization endpoint            |
| `OAUTH_TOKEN_URL`         | _(empty)_ | OAuth token endpoint                    |
| `OAUTH_INTROSPECTION_URL` | _(empty)_ | OAuth token introspection endpoint      |
| `OAUTH_REVOCATION_URL`    | _(empty)_ | OAuth token revocation endpoint         |
| `OAUTH_REGISTRATION_URL`  | _(empty)_ | OAuth dynamic client registration       |
| `OAUTH_REQUIRED_SCOPES`   | _(empty)_ | Required OAuth scopes                   |
| `OAUTH_CLIENT_ID`         | _(empty)_ | OAuth client ID                         |
| `OAUTH_CLIENT_SECRET`     | _(empty)_ | OAuth client secret                     |

#### Transform & Workers

| Variable                                   | Default   | Description                               |
| ------------------------------------------ | --------- | ----------------------------------------- |
| `TRANSFORM_WORKER_MODE`                    | `threads` | Worker mode: `threads` or `process`       |
| `TRANSFORM_WORKER_MAX_OLD_GENERATION_MB`   | _(unset)_ | V8 old generation heap limit per worker   |
| `TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB` | _(unset)_ | V8 young generation heap limit per worker |
| `TRANSFORM_WORKER_CODE_RANGE_MB`           | _(unset)_ | V8 code range limit per worker            |
| `TRANSFORM_WORKER_STACK_MB`                | _(unset)_ | Stack size limit per worker               |

#### Content Tuning

| Variable                           | Default           | Description                                      |
| ---------------------------------- | ----------------- | ------------------------------------------------ |
| `SUPERFETCH_EXTRA_NOISE_TOKENS`    | _(empty)_         | Additional CSS class/id tokens for noise removal |
| `SUPERFETCH_EXTRA_NOISE_SELECTORS` | _(empty)_         | Additional CSS selectors for noise removal       |
| `MARKDOWN_HEADING_KEYWORDS`        | _(built-in list)_ | Keywords triggering heading promotion            |
| `SUPERFETCH_LOCALE`                | _(system)_        | Locale for content processing                    |

#### Server Tuning

| Variable                           | Default         | Description                              |
| ---------------------------------- | --------------- | ---------------------------------------- |
| `SERVER_MAX_CONNECTIONS`           | `0` (unlimited) | Maximum concurrent HTTP connections      |
| `SERVER_BLOCK_PRIVATE_CONNECTIONS` | `false`         | Block connections from private IP ranges |

### Hardcoded Defaults

| Setting                  | Value                           |
| ------------------------ | ------------------------------- |
| Max HTML size            | 10 MB                           |
| Max inline content chars | 0 (unlimited)                   |
| Fetch timeout            | 15 s                            |
| Transform timeout        | 30 s                            |
| Tool timeout             | Fetch + Transform + 5 s padding |
| Max redirects            | 5                               |
| Cache TTL                | 86400 s (24 h)                  |
| Cache max keys           | 100                             |
| Rate limit               | 100 requests / 60 s             |
| Max sessions             | 200                             |
| Session TTL              | 30 min                          |
| Max URL length           | 2048 chars                      |
| Worker pool max scale    | 4                               |

## Usage

### Stdio Mode

```bash
superfetch --stdio
```

The server communicates via JSON-RPC over stdin/stdout. All MCP clients that support stdio transport can connect directly.

### HTTP Mode

```bash
superfetch
# or
PORT=8080 HOST=0.0.0.0 ALLOW_REMOTE=true superfetch
```

The server starts a Streamable HTTP endpoint at `/mcp`. Authenticate with bearer tokens via the `ACCESS_TOKENS` or `API_KEY` environment variables.

For `POST /mcp`, clients should send:

- `Accept: application/json, text/event-stream`
- `MCP-Protocol-Version: 2025-11-25` (or `2025-03-26` for legacy clients)

## MCP Surface

### Tools

#### `fetch-url`

Fetches a webpage and converts it to clean Markdown format optimized for LLM context.

**Useful for:**

- Reading documentation, blog posts, or articles
- Extracting main content while removing navigation and ads
- Caching content to speed up repeated queries

**Limitations:**

- Does not execute complex client-side JavaScript interactions

##### Parameters

| Parameter          | Type           | Required | Default | Description                                                                |
| ------------------ | -------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `url`              | `string` (URL) | Yes      | —       | The URL of the webpage to fetch (http/https, max 2048 chars)               |
| `skipNoiseRemoval` | `boolean`      | No       | `false` | Preserve navigation, footers, and other elements normally filtered         |
| `forceRefresh`     | `boolean`      | No       | `false` | Bypass cache and fetch fresh content                                       |
| `maxInlineChars`   | `number`       | No       | `0`     | Per-call inline markdown limit (`0` = unlimited; global cap still applies) |

##### Returns

```json
{
  "url": "https://example.com",
  "resolvedUrl": "https://example.com",
  "inputUrl": "https://example.com",
  "title": "Example Domain",
  "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
  "truncated": false
}
```

| Field         | Type       | Description                                     |
| ------------- | ---------- | ----------------------------------------------- |
| `url`         | `string`   | The canonical URL (pre-raw-transform)           |
| `inputUrl`    | `string`   | The original URL provided by the caller         |
| `resolvedUrl` | `string`   | The normalized/transformed URL that was fetched |
| `title`       | `string?`  | Extracted page title                            |
| `markdown`    | `string?`  | Extracted content in Markdown format            |
| `truncated`   | `boolean?` | Whether inline markdown was truncated           |
| `error`       | `string?`  | Error message if the request failed             |
| `statusCode`  | `number?`  | HTTP status code for failed requests            |
| `details`     | `object?`  | Additional error details                        |

##### Annotations

| Annotation        | Value   |
| ----------------- | ------- |
| `readOnlyHint`    | `true`  |
| `destructiveHint` | `false` |
| `idempotentHint`  | `true`  |
| `openWorldHint`   | `true`  |

##### Async Task Execution

The `fetch-url` tool supports optional async task execution. Include a `task` field in the tool call to run the fetch in the background:

```json
{
  "method": "tools/call",
  "params": {
    "name": "fetch-url",
    "arguments": { "url": "https://example.com" },
    "task": { "ttl": 30000 }
  }
}
```

Then poll `tasks/get` until the task status is `completed` or `failed`, and retrieve the result via `tasks/result`.

### Prompts

| Name             | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `get-help`       | Returns server usage guidance and workflow hints                 |
| `summarize-page` | Generates a user prompt to fetch and summarize a URL             |
| `extract-data`   | Generates a user prompt to fetch a URL and extract targeted data |

### Completions

The server supports `completion/complete` for:

- Prompt arguments (`summarize-page.url`, `extract-data.url`, `extract-data.instruction`)
- Cache resource template arguments (`superfetch://cache/{namespace}/{urlHash}`)

### Resources

| URI Pattern                                | MIME Type          | Description                                      |
| ------------------------------------------ | ------------------ | ------------------------------------------------ |
| `internal://instructions`                  | `text/markdown`    | Server instructions and usage guidance           |
| `internal://config`                        | `application/json` | Current runtime configuration (secrets redacted) |
| `superfetch://cache/{namespace}/{urlHash}` | `text/markdown`    | Cached web content snapshots (subscribable)      |

The `superfetch://cache/...` resource supports subscriptions — clients receive notifications when cached content is updated.

### Tasks

The server declares full MCP task support:

| Endpoint       | Description                          |
| -------------- | ------------------------------------ |
| `tasks/list`   | List tasks (scoped to session/owner) |
| `tasks/get`    | Get task status by ID                |
| `tasks/result` | Retrieve completed task result       |
| `tasks/cancel` | Cancel an in-flight task             |

## HTTP Mode Endpoints

| Method   | Path                                | Auth  | Description                              |
| -------- | ----------------------------------- | ----- | ---------------------------------------- |
| `GET`    | `/health`                           | No    | Health check (minimal payload)           |
| `GET`    | `/health?verbose=true`              | Yes\* | Detailed diagnostics and runtime metrics |
| `POST`   | `/mcp`                              | Yes   | MCP JSON-RPC (Streamable HTTP)           |
| `GET`    | `/mcp`                              | Yes   | SSE stream for server-initiated messages |
| `DELETE` | `/mcp`                              | Yes   | Terminate MCP session                    |
| `GET`    | `/mcp/downloads/{namespace}/{hash}` | Yes   | Download cached content                  |

\* `verbose=true` can be read without auth only for local-only deployments (`ALLOW_REMOTE=false`).

### Session Behavior

- Sessions are created on the first `POST /mcp` request with an `initialize` message
- Session ID is returned in the `mcp-session-id` response header
- Sessions expire after 30 minutes of inactivity (max 200 concurrent)

### Authentication

- **Static tokens**: Set `ACCESS_TOKENS` or `API_KEY` environment variables; pass as `Authorization: Bearer <token>`
- **OAuth**: Configure `OAUTH_*` environment variables to enable OAuth 2.0 token introspection

## Client Configuration Examples

<details>
<summary>VS Code / VS Code Insiders</summary>

Add to your VS Code settings (`.vscode/mcp.json` or User Settings):

```json
{
  "servers": {
    "superfetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary>Claude Desktop</summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superfetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install-f97316?logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

Or manually add to Cursor MCP settings:

```json
{
  "mcpServers": {
    "superfetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary>Windsurf</summary>

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "superfetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"]
    }
  }
}
```

</details>

## Security

### SSRF Protection

superFetch blocks requests to private and internal network addresses:

- **Blocked hosts**: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`
- **Blocked IPv6**: `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped private addresses (`::ffff:10.*`, etc.)
- **Cloud metadata**: `169.254.169.254` (AWS), `metadata.google.internal`, `metadata.azure.com`, `100.100.100.200` (Azure IMDS)

DNS preflight checks run on every redirect hop to prevent DNS rebinding attacks.

### Stdio Transport Safety

The server never writes non-protocol data to stdout. All logs and diagnostics go to stderr.

### Rate Limiting

HTTP mode enforces a rate limit of 100 requests per 60-second window per client.

### Content Safety

- HTML downloads are capped at 10 MB
- Worker threads run in isolation with configurable resource limits
- Auth tokens are stored in-memory only and compared using timing-safe equality

## Development Workflow

### Install Dependencies

```bash
npm install
```

### Scripts

| Script          | Command                 | Description                                  |
| --------------- | ----------------------- | -------------------------------------------- |
| `dev`           | `npm run dev`           | TypeScript watch mode                        |
| `dev:run`       | `npm run dev:run`       | Run compiled output with watch + `.env`      |
| `build`         | `npm run build`         | Clean, compile, copy assets, make executable |
| `start`         | `npm start`             | Run compiled server                          |
| `test`          | `npm test`              | Run test suite (Node.js native test runner)  |
| `test:coverage` | `npm run test:coverage` | Run tests with coverage                      |
| `lint`          | `npm run lint`          | ESLint                                       |
| `lint:fix`      | `npm run lint:fix`      | ESLint with auto-fix                         |
| `format`        | `npm run format`        | Prettier                                     |
| `type-check`    | `npm run type-check`    | TypeScript type checking                     |
| `inspector`     | `npm run inspector`     | Build and launch MCP Inspector               |

## Build and Release

```bash
npm run build        # Clean → Compile → Copy Assets → chmod
npm run prepublishOnly  # Lint → Type-Check → Build
npm publish          # Publish to npm
```

The `prepare` script runs `npm run build` automatically on `npm install` from source.

## Troubleshooting

### MCP Inspector

Use the built-in inspector to test the server interactively:

```bash
npm run inspector
```

This builds the project and launches `@modelcontextprotocol/inspector` pointing to the compiled server.

### Common Issues

| Issue                     | Solution                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` on URL | URL is blocked (private IP/localhost) or malformed. Do not retry.                     |
| `queue_full` error        | Worker pool is saturated. Wait briefly, then retry or use async task mode.            |
| Garbled output            | Binary content (images, PDFs) cannot be converted. Ensure the URL serves HTML.        |
| No output in stdio mode   | Ensure `--stdio` flag is passed. Without it, the server starts in HTTP mode.          |
| Auth errors in HTTP mode  | Set `ACCESS_TOKENS` or `API_KEY` env var and pass as `Authorization: Bearer <token>`. |

### Stdout / Stderr Guidance

In stdio mode, **stdout** is reserved exclusively for MCP JSON-RPC messages. Logs and diagnostics are written to **stderr**. Never pipe stdout to a log file when using stdio transport.

## License

[MIT](https://opensource.org/licenses/MIT)
