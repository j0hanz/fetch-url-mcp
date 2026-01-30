<!-- markdownlint-disable MD033 -->

# SuperFetch MCP Server

<img src="assets/logo.svg" alt="SuperFetch MCP Logo" width="300">

[![npm version](https://img.shields.io/npm/v/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![license](https://img.shields.io/npm/l/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![Node.js](https://img.shields.io/badge/Node.js-%3E=20.18.1-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.25.x-6f42c1)](https://github.com/modelcontextprotocol/sdk)

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D&quality=insiders) [![Install in Claude Desktop](https://img.shields.io/badge/Claude_Desktop-Install-ff9800?style=flat-square&logo=anthropic&logoColor=white)](https://claude.ai/desktop/mcp/install?name=superfetch&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D)

Fetch and convert public web pages to clean, AI-friendly Markdown via MCP.

## Overview

SuperFetch is a Node.js MCP server that fetches public HTTP(S) pages, extracts
primary content, and converts it into clean Markdown. It runs either as a stdio
MCP server (for local clients) or as a Streamable HTTP MCP server with auth,
cache, and SSRF protections.

## Key Features

- HTML to Markdown using Mozilla Readability + node-html-markdown.
- Raw content URL rewriting for GitHub, GitLab, Bitbucket, and Gist.
- In-memory LRU cache exposed as MCP resources and HTTP download endpoints.
- Stdio or Streamable HTTP transport with session management.
- SSRF protections: blocked private IP ranges and internal hostnames.

## Tech Stack

- Runtime: Node.js >= 20.18.1 (engines)
- Language: TypeScript 5.9.3 (dev dependency)
- MCP SDK: @modelcontextprotocol/sdk ^1.25.3
- HTML processing: @mozilla/readability ^0.6.0, linkedom ^0.18.12
- Markdown conversion: node-html-markdown ^2.0.0
- HTTP client: undici ^7.19.2
- Validation: zod ^4.3.6
- Package manager: npm (package-lock.json)

## Architecture

Fetch pipeline (simplified):

1. Validate and normalize the URL (http/https only, max length 2048).
2. Block internal hosts and private IP ranges.
3. Rewrite supported repo URLs to raw content.
4. Fetch HTML with undici (15s timeout, 10 MB max, 5 redirects).
5. Extract main content with Readability + DOM cleanup.
6. Convert to Markdown, inject metadata, and return via MCP.
7. Cache the result and expose it as a resource or download.

## Repository Structure

```text
.
├── assets/               # Logo and static assets copied to dist
├── scripts/              # Build and validation utilities
├── src/                  # MCP server implementation (TS)
│   ├── workers/          # Worker-thread transform implementation
│   ├── http-native.ts    # Streamable HTTP server
│   ├── mcp.ts            # MCP server wiring
│   ├── tools.ts          # fetch-url tool implementation
│   └── ...
├── tests/                # Node test runner tests (import dist)
├── CONFIGURATION.md      # Full configuration reference
├── AGENTS.md             # Agent guidance
├── package.json
└── tsconfig.json
```

## Requirements

- Node.js >= 20.18.1
- npm (uses package-lock.json)

## Quickstart (stdio)

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

SuperFetch is configured entirely via environment variables. Set them in your
MCP client configuration (the `env` field) or in the shell before starting the
server. For the full reference, see `CONFIGURATION.md`.

### Runtime modes

| Mode  | Flag      | Description                                                         |
| ----- | --------- | ------------------------------------------------------------------- |
| Stdio | `--stdio` | Communicates via stdin/stdout. No HTTP server.                      |
| HTTP  | (default) | Starts an HTTP server. Requires static token(s) or OAuth to be set. |

### CLI arguments

| Argument  | Type    | Default | Description                         |
| --------- | ------- | ------- | ----------------------------------- |
| `--stdio` | boolean | false   | Run in stdio mode (no HTTP server). |

### Core server settings

| Variable                           | Default              | Description                                                    |
| ---------------------------------- | -------------------- | -------------------------------------------------------------- |
| `HOST`                             | `127.0.0.1`          | HTTP bind address.                                             |
| `PORT`                             | `3000`               | HTTP port (1024-65535, `0` for ephemeral).                     |
| `USER_AGENT`                       | `superFetch-MCP/2.0` | User-Agent for outbound requests.                              |
| `CACHE_ENABLED`                    | `true`               | Enable in-memory cache.                                        |
| `CACHE_TTL`                        | `3600`               | Cache TTL in seconds (60-86400).                               |
| `LOG_LEVEL`                        | `info`               | Logging level (`debug`, `info`, `warn`, `error`).              |
| `ALLOW_REMOTE`                     | `false`              | Allow non-loopback binds (OAuth required).                     |
| `ALLOWED_HOSTS`                    | (empty)              | Additional allowed Host/Origin values (comma/space separated). |
| `TRANSFORM_TIMEOUT_MS`             | `30000`              | Worker transform timeout in ms (5000-120000).                  |
| `TRANSFORM_STAGE_WARN_RATIO`       | `0.5`                | Emit warnings when stage exceeds ratio of timeout.             |
| `TOOL_TIMEOUT_MS`                  | computed             | Overall tool timeout in ms (1000-300000).                      |
| `TRANSFORM_METADATA_FORMAT`        | `markdown`           | Metadata format: `markdown` or `frontmatter`.                  |
| `ENABLED_TOOLS`                    | `fetch-url`          | Comma/space-separated list of enabled tools.                   |
| `SUPERFETCH_EXTRA_NOISE_TOKENS`    | (empty)              | Extra noise tokens for DOM noise removal.                      |
| `SUPERFETCH_EXTRA_NOISE_SELECTORS` | (empty)              | Extra CSS selectors for DOM noise removal.                     |

`TOOL_TIMEOUT_MS` defaults to 15s fetch + `TRANSFORM_TIMEOUT_MS` + 5s.

### HTTP server tuning (optional)

| Variable                       | Default | Description                                   |
| ------------------------------ | ------- | --------------------------------------------- |
| `SERVER_HEADERS_TIMEOUT_MS`    | (unset) | Sets `server.headersTimeout` (1000-600000).   |
| `SERVER_REQUEST_TIMEOUT_MS`    | (unset) | Sets `server.requestTimeout` (1000-600000).   |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS` | (unset) | Sets `server.keepAliveTimeout` (1000-600000). |
| `SERVER_SHUTDOWN_CLOSE_IDLE`   | `false` | Close idle connections on shutdown.           |
| `SERVER_SHUTDOWN_CLOSE_ALL`    | `false` | Close all connections on shutdown.            |

### Auth (HTTP mode)

| Variable        | Default | Description                                                 |
| --------------- | ------- | ----------------------------------------------------------- |
| `AUTH_MODE`     | auto    | `static` or `oauth` (auto-selects OAuth when URLs are set). |
| `ACCESS_TOKENS` | (empty) | Comma/space-separated static bearer tokens.                 |
| `API_KEY`       | (empty) | Adds a static bearer token and enables `X-API-Key`.         |

Static mode requires at least one token (`ACCESS_TOKENS` or `API_KEY`).

### OAuth (HTTP mode)

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

## Usage

### Stdio (local MCP clients)

```bash
npx -y @j0hanz/superfetch@latest --stdio
```

### HTTP server (local only, static token)

```bash
API_KEY=YOUR_TOKEN_HERE npm start
```

Requires `npm run build` before `npm start` when running from source.

Remote bindings require `ALLOW_REMOTE=true` and OAuth configuration.

## MCP Surface

### Tools

#### `fetch-url`

Fetches a webpage and converts it to clean Markdown.

Parameters:

| Name  | Type   | Required | Description                          |
| ----- | ------ | -------- | ------------------------------------ |
| `url` | string | Yes      | Public http(s) URL, max length 2048. |

Structured response fields:

- `url` (string): fetched URL
- `inputUrl` (string, optional): original input URL
- `resolvedUrl` (string, optional): normalized or raw-content URL
- `title` (string, optional): page title
- `markdown` (string, optional): inline markdown (may be truncated)
- `error` (string, optional): error message on failure

Limitations:

- Only http/https URLs are accepted; URLs with embedded credentials are rejected.
- Client-side JavaScript is not executed.

Large content handling:

- Inline markdown is capped at 20,000 characters.
- If cache is enabled and content exceeds the inline limit, the tool response
  includes a `resource_link` block pointing to `superfetch://cache/markdown/{urlHash}`.
- If cache is disabled, inline markdown is truncated with `...[truncated]`.
- In stdio mode, the tool also embeds a `resource` block containing full
  markdown content when available.

### Resources

| URI pattern                             | Description                                | MIME type          |
| --------------------------------------- | ------------------------------------------ | ------------------ |
| `superfetch://cache/markdown/{urlHash}` | Cached markdown content entry.             | `text/markdown`    |
| `internal://instructions`               | Server usage instructions.                 | `text/markdown`    |
| `internal://config`                     | Current runtime config (secrets redacted). | `application/json` |

### Prompts

- `summarize-webpage` (registered when `fetch-url` is enabled)

### Tasks

`fetch-url` supports async execution via MCP tasks. Call `tools/call` with a
`task` payload to start a background fetch, then use `tasks/get`,
`tasks/result`, or `tasks/cancel` to manage it.

## HTTP Mode Endpoints

| Method | Path                              | Auth | Notes                                              |
| ------ | --------------------------------- | ---- | -------------------------------------------------- |
| GET    | `/health`                         | No   | Health check.                                      |
| POST   | `/mcp`                            | Yes  | Streamable HTTP JSON-RPC requests.                 |
| GET    | `/mcp`                            | Yes  | SSE stream (requires `Accept: text/event-stream`). |
| DELETE | `/mcp`                            | Yes  | Close the session.                                 |
| GET    | `/mcp/downloads/:namespace/:hash` | Yes  | Download cached markdown.                          |

Notes:

- HTTP requests must include `MCP-Protocol-Version: 2025-11-25`.
- Sessions are managed via the `mcp-session-id` header.

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

## Development Workflow

### Install dependencies

```bash
npm install
```

Use `npm ci` for clean, reproducible installs.

### Common scripts

| Script                 | Command                                                                                                             | Purpose                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| clean                  | `node scripts/build.mjs clean`                                                                                      | Remove dist and TS build info.        |
| validate:instructions  | `node scripts/build.mjs validate:instructions`                                                                      | Validate `src/instructions.md`.       |
| build                  | `node scripts/build.mjs`                                                                                            | Compile TS, copy assets, set exec bit |
| copy:assets            | `node scripts/build.mjs copy:assets`                                                                                | Copy assets/instructions to dist.     |
| prepare                | `npm run build`                                                                                                     | Prepare package for publishing.       |
| dev                    | `tsc --watch --preserveWatchOutput`                                                                                 | TypeScript watch mode.                |
| dev:run                | `node --env-file=.env --watch dist/index.js`                                                                        | Run compiled server in watch mode.    |
| start                  | `node dist/index.js`                                                                                                | Start HTTP server (default).          |
| format                 | `prettier --write .`                                                                                                | Format codebase.                      |
| type-check             | `tsc --noEmit`                                                                                                      | Type checking.                        |
| type-check:diagnostics | `tsc --noEmit --extendedDiagnostics`                                                                                | Type check diagnostics.               |
| type-check:trace       | `node -e "require('fs').rmSync('.ts-trace',{recursive:true,force:true})" && tsc --noEmit --generateTrace .ts-trace` | Generate TS trace.                    |
| lint                   | `eslint .`                                                                                                          | Lint.                                 |
| lint:fix               | `eslint . --fix`                                                                                                    | Lint and fix.                         |
| test                   | `npm run build --silent && node --test --experimental-transform-types`                                              | Run tests (builds first).             |
| test:coverage          | `npm run build --silent && node --test --experimental-transform-types --experimental-test-coverage`                 | Test with coverage.                   |
| knip                   | `knip`                                                                                                              | Dead code analysis.                   |
| knip:fix               | `knip --fix`                                                                                                        | Fix knip issues.                      |
| inspector              | `npx @modelcontextprotocol/inspector`                                                                               | MCP Inspector.                        |
| prepublishOnly         | `npm run lint && npm run type-check && npm run build`                                                               | Prepublish checks.                    |

## Build and Release

- `npm run build` runs `scripts/build.mjs`, compiling TS with
  `tsconfig.build.json`, copying `assets/` and `src/instructions.md` to `dist/`,
  and making `dist/index.js` executable.
- GitHub Releases trigger the publish workflow (lint, type-check, build,
  version sync, then `npm publish`).

## Troubleshooting

- Tests import from `dist/`. Run `npm test` (builds first) or `npm run build`
  before running individual test files.
- HTTP mode requires auth. Set `API_KEY` or `ACCESS_TOKENS` (or configure OAuth).
- Non-loopback bindings require `ALLOW_REMOTE=true` and OAuth configuration.
- Missing `MCP-Protocol-Version: 2025-11-25` yields a 400 error.
- Large pages may return a `resource_link` to cached content instead of inline
  markdown.
- Requests to private IPs, localhost, or `.local`/`.internal` hosts are blocked.

<!-- markdownlint-enable MD033 -->
