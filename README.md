# Fetch URL MCP Server

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffetch-url-mcp?style=flat-square&logo=npm)](https://www.npmjs.com/package/%40j0hanz%2Ffetch-url-mcp) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#contributing-and-license)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22fetch-url-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D%7D)

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D)

An MCP server that fetches web pages and converts them to clean, readable Markdown.

## Overview

This server takes a URL, fetches the page, and strips away everything you don't need — navigation, sidebars, banners, scripts — leaving just the main content as Markdown. It's perfect for feeding into LLMs, giving them the distilled essence of a page without the noise. It also recognizes GitHub, GitLab, Bitbucket, and Gist URLs and rewrites them to fetch the raw content directly.

By default it runs over stdio. Pass `--http` if you need a proper HTTP endpoint with auth, rate limiting, TLS, and session support.

## Key Features

- **HTML to Markdown** — Turns any public web page into clean, readable Markdown with metadata like `title`, `url`, `contentSize`, and `truncated`.
- **Smart URL handling** — Recognizes GitHub, GitLab, Bitbucket, and Gist page URLs and rewrites them to raw-content endpoints before fetching.
- **Task mode** — Big or slow pages can run as async MCP tasks with progress updates, instead of blocking. In HTTP mode, tasks are bound to the authenticated caller rather than a single MCP session, so they can be resumed after reconnecting with the same credentials. Polling task state also exposes `progress` and `total` when available.
- **Self-documenting** — Includes an `internal://instructions` resource and a `get-help` prompt so clients know how to use it.
- **HTTP mode** — Optionally serves over Streamable HTTP with host/origin validation, bearer or OAuth auth, rate limiting, health checks, and TLS.

## Web Client

A browser-based client is available if you want to use the server without any MCP setup.

**[Live app](https://fetch-url-client.vercel.app)** · [Source code](https://github.com/j0hanz/fetch-url)

## Requirements

- **Node.js** >= 24
- **Docker** (optional) — only needed if you want to run the container image

## Quick Start

Add this to your MCP client config:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

## Client Configuration

<details>
<summary><b>Install in VS Code</b></summary>

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

Or install via CLI:

```sh
code --add-mcp '{"name":"fetch-url-mcp","command":"npx","args":["-y","@j0hanz/fetch-url-mcp@latest"]}'
```

For more info, see [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

</details>

<details>
<summary><b>Install in VS Code Insiders</b></summary>

[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D&quality=insiders)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

Or install via CLI:

```sh
code-insiders --add-mcp '{"name":"fetch-url-mcp","command":"npx","args":["-y","@j0hanz/fetch-url-mcp@latest"]}'
```

For more info, see [VS Code Insiders MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

</details>

<details>
<summary><b>Install in Cursor</b></summary>

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol).

</details>

<details>
<summary><b>Install in Visual Studio</b></summary>

[![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22fetch-url-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D%7D)

For solution-scoped setup, add this to `.mcp.json` at the solution root:

```json
{
  "servers": {
    "fetch-url-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Visual Studio MCP docs](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers).

</details>

<details>
<summary><b>Install in Goose</b></summary>

Add to `~/.config/goose/config.yaml` on macOS/Linux or `%APPDATA%\Block\goose\config\config.yaml` on Windows:

```yaml
extensions:
  fetch-url-mcp:
    name: fetch-url-mcp
    cmd: npx
    args: ['-y', '@j0hanz/fetch-url-mcp@latest']
    enabled: true
    type: stdio
    timeout: 300
```

For more info, see [Goose extension docs](https://block.github.io/goose/docs/getting-started/using-extensions/).

</details>

<details>
<summary><b>Install in LM Studio</b></summary>

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D)

Add to `~/.lmstudio/mcp.json` on macOS/Linux or `%USERPROFILE%/.lmstudio/mcp.json` on Windows:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [LM Studio MCP docs](https://lmstudio.ai/docs/basics/mcp).

</details>

<details>
<summary><b>Install in Claude Desktop</b></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Claude Desktop MCP docs](https://modelcontextprotocol.io/quickstart/user).

</details>

<details>
<summary><b>Install in Claude Code</b></summary>

Use the CLI:

```sh
claude mcp add fetch-url-mcp -- npx -y @j0hanz/fetch-url-mcp@latest
```

For project-scoped config, Claude Code writes `.mcp.json` with:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"],
      "env": {}
    }
  }
}
```

For more info, see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp).

</details>

<details>
<summary><b>Install in Windsurf</b></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp).

</details>

<details>
<summary><b>Install in Amp</b></summary>

Add to `~/.config/amp/settings.json` on macOS/Linux, `%USERPROFILE%\.config\amp\settings.json` on Windows, or `.amp/settings.json` for workspace-scoped config:

```json
{
  "amp.mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

Or install via CLI:

```sh
amp mcp add fetch-url-mcp -- npx -y @j0hanz/fetch-url-mcp@latest
```

For more info, see [Amp docs](https://ampcode.com/manual).

</details>

<details>
<summary><b>Install in Cline</b></summary>

Open the MCP Servers panel, choose `Configure MCP Servers`, and add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Cline MCP docs](https://docs.cline.bot/mcp/configuring-mcp-servers).

</details>

<details>
<summary><b>Install in Codex CLI</b></summary>

Use the CLI:

```sh
codex mcp add fetch-url-mcp -- npx -y @j0hanz/fetch-url-mcp@latest
```

Or add this to `~/.codex/config.toml` or project-scoped `.codex/config.toml`:

```toml
[mcp_servers.fetch-url-mcp]
command = "npx"
args = ["-y", "@j0hanz/fetch-url-mcp@latest"]
```

For more info, see [Codex MCP docs](https://developers.openai.com/codex/mcp/).

</details>

<details>
<summary><b>Install in GitHub Copilot</b></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [GitHub Copilot MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

</details>

<details>
<summary><b>Install in Warp</b></summary>

Open `Personal > MCP Servers` in Warp, choose `+ Add`, and either add a CLI server with:

- `command`: `npx`
- `args`: `["-y", "@j0hanz/fetch-url-mcp@latest"]`

Or paste this JSON snippet when using Warp's multi-server import flow:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Warp MCP docs](https://docs.warp.dev/features/warp-ai/mcp).

</details>

<details>
<summary><b>Install in Kiro</b></summary>

Use Kiro's MCP Servers panel or the `Add to Kiro` install flow. Kiro stores workspace-scoped MCP config in `.kiro/settings/mcp.json` and user-scoped config in `~/.kiro/settings/mcp.json`.

For this server, use:

- `command`: `npx`
- `args`: `["-y", "@j0hanz/fetch-url-mcp@latest"]`

For more info, see [Kiro MCP docs](https://kiro.dev/blog/unlock-your-development-productivity-with-kiro-and-mcp/).

</details>

<details>
<summary><b>Install in Gemini CLI</b></summary>

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Gemini CLI MCP docs](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html).

</details>

<details>
<summary><b>Install in Zed</b></summary>

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"],
      "env": {}
    }
  }
}
```

For more info, see [Zed MCP docs](https://zed.dev/docs/ai/mcp).

</details>

<details>
<summary><b>Install in Augment</b></summary>

Use the Augment Settings panel and either add the server manually or choose `Import from JSON`:

```json
{
  "mcpServers": {
    "fetch-url-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
    }
  }
}
```

For more info, see [Augment MCP docs](https://docs.augmentcode.com/setup-augment/mcp).

</details>

<details>
<summary><b>Install in Roo Code</b></summary>

Use Roo Code's MCP Servers UI or marketplace flow.

For this server, use:

- `command`: `npx`
- `args`: `["-y", "@j0hanz/fetch-url-mcp@latest"]`

For more info, see [Roo Code docs](https://docs.roocode.com/).

</details>

<details>
<summary><b>Install in Kilo Code</b></summary>

Use Kilo Code's MCP Servers UI or marketplace flow.

For this server, use:

- `command`: `npx`
- `args`: `["-y", "@j0hanz/fetch-url-mcp@latest"]`

For more info, see [Kilo Code docs](https://kilocode.ai/docs).

</details>

## Use Cases

- **Documentation for LLMs** — Grab a docs page, blog post, or reference article as Markdown and pass it straight into a context window.
- **Repository content** — Hand it a GitHub, GitLab, or Bitbucket URL and it resolves the raw content endpoint. Works with Gists too.
- **Slow or large pages** — Task mode lets big fetches run in the background while sending monotonic progress updates back to the client, while `tasks/get` exposes the latest `statusMessage`, `progress`, and `total`.

## Architecture

```text
[MCP Client]
  ├─ stdio -> `src/index.ts` -> `startStdioServer()` -> `createMcpServer()`
  └─ HTTP (`--http`) -> `src/index.ts` -> `startHttpServer()` -> HTTP dispatcher
       ├─ `GET /health`
       ├─ `GET /.well-known/oauth-protected-resource`
       ├─ `GET /.well-known/oauth-protected-resource/mcp`
       └─ `POST|GET|DELETE /mcp`

`createMcpServer()`
  ├─ registers tool: `fetch-url`
  ├─ registers prompt: `get-help`
  ├─ registers resources:
  │    - `internal://instructions`
  ├─ enables capabilities: logging, resources, prompts, tasks
  └─ installs task handlers, log-level handling, and shutdown cleanup

`fetch-url` execution
  ├─ validate input with `fetchUrlInputSchema`
  ├─ normalize URL and block local/private targets unless allowed
  ├─ rewrite supported code-host URLs to raw endpoints when possible
  ├─ fetch content via the shared pipeline
  ├─ transform HTML into Markdown in the transform worker path
  └─ validate `structuredContent` with `fetchUrlOutputSchema`
```

### Request Lifecycle

```text
[Client] -- initialize {protocolVersion, capabilities} --> [Server]
[Server] -- {protocolVersion, capabilities, serverInfo} --> [Client]
[Client] -- notifications/initialized --> [Server]
[Client] -- tools/call {name, arguments} --> [Server]
[Server] -- {content: [{type, text}], structuredContent?, isError?} --> [Client]
```

## MCP Surface

### Tools

#### `fetch-url`

Takes a URL and returns Markdown. Read-only — no JavaScript execution. Supports running as a background MCP task for large or slow pages. When task mode is used, `tasks/get` and `tasks/list` include `statusMessage`, `progress`, and `total` whenever progress has been reported.

| Parameter | Type     | Required | Description                 |
| --------- | -------- | -------- | --------------------------- |
| `url`     | `string` | yes      | Target URL. Max 2048 chars. |

You get text content back by default. If output validation passes, the response also includes `structuredContent` with typed fields: `url`, `resolvedUrl`, `finalUrl`, `title`, `metadata`, `markdown`, `fetchedAt`, `contentSize`, and `truncated`. A `true` value for `truncated` means the content hit a server-side size limit.

To opt into progress updates, include `_meta.progressToken` in the tool call. The token may be a string or number. The server may then emit monotonic `notifications/progress` updates, and task mode reuses the same token until the task reaches a terminal state.

To run the tool in task mode, include `_meta["modelcontextprotocol.io/task"] = { "taskId": "<client-id>", "keepAlive": <ms> }`. `tasks/result` returns output only after the task reaches `completed`. Task-linked progress notifications, task summaries, and final results include `_meta["modelcontextprotocol.io/related-task"] = { "taskId": "<client-id>" }`.

```json
{
  "method": "tools/call",
  "params": {
    "name": "fetch-url",
    "arguments": {
      "url": "https://example.com/docs"
    },
    "_meta": {
      "progressToken": 7
    }
  }
}
```

```text
1. [Client] -- tools/call {name: "fetch-url", arguments} --> [Server]
2. [Server] -- dispatch("fetch-url") --> [src/tools/fetch-url.ts]
3. [Handler] -- validate(fetchUrlInputSchema) --> normalize / fetch / transform
4. [Handler] -- validate(fetchUrlOutputSchema) --> assemble content + structuredContent
5. [Server] -- result or tool error --> [Client]
```

### Resources

| Resource                     | URI                       | MIME Type       | Description                                  |
| ---------------------------- | ------------------------- | --------------- | -------------------------------------------- |
| `fetch-url-mcp-instructions` | `internal://instructions` | `text/markdown` | Guidance for using the Fetch URL MCP server. |

### Prompts

| Prompt     | Arguments | Description                                                                     |
| ---------- | --------- | ------------------------------------------------------------------------------- |
| `get-help` | none      | Return Fetch URL server instructions: workflows, task mode, and error handling. |

## MCP Capabilities

| Capability                      | Status    | Notes                                                                                                                                                                                                          |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completions                     | confirmed | Advertised in `createServerCapabilities()`.                                                                                                                                                                    |
| logging                         | confirmed | Advertised in `createServerCapabilities()` and handled through `SetLevelRequestSchema`.                                                                                                                        |
| resources subscribe/listChanged | confirmed | Advertised in `createServerCapabilities()`.                                                                                                                                                                    |
| prompts                         | confirmed | `get-help` is registered during server startup.                                                                                                                                                                |
| tasks                           | confirmed | Advertised in `createServerCapabilities()` and backed by registered task handlers plus optional tool task support.                                                                                             |
| progress notifications          | confirmed | Opt-in via `_meta.progressToken`. Tool execution reports monotonic `notifications/progress` updates during fetch and transform stages, and task-mode progress reuses the caller's token for the task lifetime. |

### Tool Annotations

| Annotation        | Value   |
| ----------------- | ------- |
| `readOnlyHint`    | `true`  |
| `destructiveHint` | `false` |
| `idempotentHint`  | `true`  |
| `openWorldHint`   | `true`  |

### Structured Output

The tool declares an `outputSchema` and includes `structuredContent` in the response when validation passes. Clients that support structured output get typed data directly; the rest use the text fallback.

## Configuration

All configuration is through environment variables. For basic stdio usage, nothing needs to be set.

### HTTP Server

| Variable                              | Default     | Notes                                                                 |
| ------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `HOST`                                | `127.0.0.1` | Bind address. Non-loopback bindings also require `ALLOW_REMOTE=true`. |
| `PORT`                                | `3000`      | Listening port for `--http`.                                          |
| `ALLOW_REMOTE`                        | `false`     | Must be enabled to bind to a non-loopback interface.                  |
| `ALLOWED_HOSTS`                       | empty       | Additional allowed `Host` and `Origin` values.                        |
| `SERVER_MAX_CONNECTIONS`              | `0`         | Optional connection cap.                                              |
| `SERVER_HEADERS_TIMEOUT_MS`           | unset       | Optional Node server tuning.                                          |
| `SERVER_REQUEST_TIMEOUT_MS`           | unset       | Optional Node server tuning.                                          |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS`        | unset       | Optional keep-alive tuning.                                           |
| `SERVER_KEEP_ALIVE_TIMEOUT_BUFFER_MS` | unset       | Optional keep-alive tuning buffer.                                    |
| `SERVER_MAX_HEADERS_COUNT`            | unset       | Optional header count limit.                                          |
| `SERVER_BLOCK_PRIVATE_CONNECTIONS`    | `false`     | Enables inbound private-network protections.                          |

### Authentication & OAuth

| Variable                  | Default | Notes                                                       |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `ACCESS_TOKENS`           | unset   | Comma- or space-separated static bearer tokens.             |
| `API_KEY`                 | unset   | Alternate static token source for header auth.              |
| `OAUTH_ISSUER_URL`        | unset   | Enables OAuth mode when combined with the other OAuth URLs. |
| `OAUTH_AUTHORIZATION_URL` | unset   | Optional explicit authorization endpoint.                   |
| `OAUTH_TOKEN_URL`         | unset   | Optional explicit token endpoint.                           |
| `OAUTH_REVOCATION_URL`    | unset   | Optional OAuth revocation endpoint.                         |
| `OAUTH_REGISTRATION_URL`  | unset   | Optional OAuth dynamic client registration endpoint.        |
| `OAUTH_INTROSPECTION_URL` | unset   | Required for OAuth token introspection.                     |
| `OAUTH_REQUIRED_SCOPES`   | empty   | Required scopes enforced after auth.                        |
| `OAUTH_CLIENT_ID`         | unset   | Optional introspection client ID.                           |
| `OAUTH_CLIENT_SECRET`     | unset   | Optional introspection client secret.                       |

### TLS

| Variable               | Default | Notes                                                       |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `SERVER_TLS_KEY_FILE`  | unset   | Enable HTTPS when set together with `SERVER_TLS_CERT_FILE`. |
| `SERVER_TLS_CERT_FILE` | unset   | TLS certificate path.                                       |
| `SERVER_TLS_CA_FILE`   | unset   | Optional custom CA bundle.                                  |

### Fetching

| Variable            | Default                   | Notes                                              |
| ------------------- | ------------------------- | -------------------------------------------------- |
| `ALLOW_LOCAL_FETCH` | `false`                   | Allows loopback and private-network fetch targets. |
| `FETCH_TIMEOUT_MS`  | `15000`                   | Network fetch timeout in milliseconds.             |
| `USER_AGENT`        | `fetch-url-mcp/<version>` | Override the outbound user agent string.           |

### Tool Output

| Variable                   | Default | Notes                                          |
| -------------------------- | ------- | ---------------------------------------------- |
| `MAX_INLINE_CONTENT_CHARS` | `0`     | `0` means no explicit inline truncation limit. |

### Tasks

| Variable                     | Default | Notes                                                                                |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `TASKS_MAX_TOTAL`            | `5000`  | Total retained task capacity, including completed/cancelled tasks until they expire. |
| `TASKS_MAX_PER_OWNER`        | `1000`  | Per-owner retained task cap, clamped to the total cap.                               |
| `TASKS_STATUS_NOTIFICATIONS` | `false` | Enables status notifications for tasks.                                              |
| `TASKS_REQUIRE_INTERCEPTION` | `true`  | Requires interception for task-capable tool execution.                               |

### Transform Workers

| Variable                                   | Default   | Notes                                 |
| ------------------------------------------ | --------- | ------------------------------------- |
| `TRANSFORM_CANCEL_ACK_TIMEOUT_MS`          | `200`     | Cancellation acknowledgement timeout. |
| `TRANSFORM_WORKER_MODE`                    | `threads` | Worker execution mode.                |
| `TRANSFORM_WORKER_MAX_OLD_GENERATION_MB`   | unset     | Optional worker memory limit.         |
| `TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB` | unset     | Optional worker memory limit.         |
| `TRANSFORM_WORKER_CODE_RANGE_MB`           | unset     | Optional worker memory limit.         |
| `TRANSFORM_WORKER_STACK_MB`                | unset     | Optional worker stack size.           |

### Content Cleanup

| Variable                              | Default        | Notes                                      |
| ------------------------------------- | -------------- | ------------------------------------------ |
| `FETCH_URL_MCP_EXTRA_NOISE_TOKENS`    | empty          | Extra noise-removal tokens.                |
| `FETCH_URL_MCP_EXTRA_NOISE_SELECTORS` | empty          | Extra DOM selectors for noise removal.     |
| `FETCH_URL_MCP_LOCALE`                | system default | Locale override for extraction heuristics. |
| `MARKDOWN_HEADING_KEYWORDS`           | built-in list  | Override heading keywords used by cleanup. |

### Logging

| Variable     | Default | Notes                                |
| ------------ | ------- | ------------------------------------ |
| `LOG_LEVEL`  | `info`  | `debug`, `info`, `warn`, or `error`. |
| `LOG_FORMAT` | `text`  | Set to `json` for structured logs.   |

## HTTP Endpoints

| Method   | Path                                        | Auth                                       | Purpose                                                 |
| -------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `GET`    | `/health`                                   | no, unless `?verbose=1` on a remote server | Basic health response, with optional diagnostics.       |
| `GET`    | `/.well-known/oauth-protected-resource`     | no                                         | OAuth protected-resource metadata.                      |
| `GET`    | `/.well-known/oauth-protected-resource/mcp` | no                                         | OAuth protected-resource metadata for the MCP endpoint. |
| `POST`   | `/mcp`                                      | yes                                        | Session initialization and JSON-RPC requests.           |
| `GET`    | `/mcp`                                      | yes                                        | Session-bound server-to-client stream handling.         |
| `DELETE` | `/mcp`                                      | yes                                        | Session shutdown.                                       |

## Security

| Control                    | Status      | Notes                                                                                                                                    |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host and origin validation | implemented | HTTP requests are rejected unless `Host` and `Origin` match the allowlist built from loopback, the configured host, and `ALLOWED_HOSTS`. |
| Authentication             | implemented | HTTP mode supports static bearer tokens locally or OAuth token introspection; remote bindings require OAuth.                             |
| Protocol version checks    | implemented | Session-bound MCP HTTP requests validate `MCP-Protocol-Version` and pin it to the negotiated session version.                            |
| Rate limiting              | implemented | Requests pass through the HTTP rate limiter before route dispatch.                                                                       |
| Outbound SSRF protections  | implemented | Local/private IPs, metadata endpoints, and `.local`/`.internal` hosts are blocked unless `ALLOW_LOCAL_FETCH=true`.                       |
| TLS                        | optional    | HTTPS is enabled when both TLS key and certificate files are configured.                                                                 |
| Stdio logging safety       | implemented | Server logs are written to stderr, not stdout, so stdio MCP traffic stays clean.                                                         |

## Development

### Essential Commands

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `npm run build`      | Clean, compile TypeScript, copy assets.           |
| `npm run dev`        | Watch mode TypeScript compilation.                |
| `npm run dev:run`    | Run the server with `--watch` and `.env` support. |
| `npm start`          | Start the compiled server.                        |
| `npm test`           | Run the full test suite.                          |
| `npm run lint`       | Lint with ESLint.                                 |
| `npm run lint:fix`   | Auto-fix lint issues.                             |
| `npm run type-check` | Type-check source and tests.                      |
| `npm run format`     | Format with Prettier.                             |
| `npm run inspector`  | Build and launch MCP Inspector.                   |

<details>
<summary><b>All npm scripts</b></summary>

| Script                   | Command                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `clean`                  | `node scripts/tasks.mjs clean`                                                                                      |
| `build`                  | `node scripts/tasks.mjs build`                                                                                      |
| `copy:assets`            | `node scripts/tasks.mjs copy:assets`                                                                                |
| `prepare`                | `npm run build`                                                                                                     |
| `dev`                    | `tsc --watch --preserveWatchOutput`                                                                                 |
| `dev:run`                | `node --env-file=.env --watch dist/index.js`                                                                        |
| `start`                  | `node dist/index.js`                                                                                                |
| `format`                 | `prettier --write .`                                                                                                |
| `type-check`             | `node scripts/tasks.mjs type-check`                                                                                 |
| `type-check:src`         | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`                                                    |
| `type-check:tests`       | `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit`                                               |
| `type-check:diagnostics` | `tsc --noEmit --extendedDiagnostics`                                                                                |
| `type-check:trace`       | `node -e "require('fs').rmSync('.ts-trace',{recursive:true,force:true})" && tsc --noEmit --generateTrace .ts-trace` |
| `lint`                   | `eslint .`                                                                                                          |
| `lint:tests`             | `eslint src/__tests__`                                                                                              |
| `lint:fix`               | `eslint . --fix`                                                                                                    |
| `test`                   | `node scripts/tasks.mjs test`                                                                                       |
| `test:fast`              | `node --test --import tsx/esm src/__tests__/**/*.test.ts node-tests/**/*.test.ts`                                   |
| `test:coverage`          | `node scripts/tasks.mjs test --coverage`                                                                            |
| `knip`                   | `knip`                                                                                                              |
| `knip:fix`               | `knip --fix`                                                                                                        |
| `inspector`              | `npm run build && npx -y @modelcontextprotocol/inspector node dist/index.js --stdio`                                |
| `prepublishOnly`         | `npm run lint && npm run type-check && npm run build`                                                               |

</details>

## Build and Release

- `npm run prepublishOnly` runs lint, type-check, and build as a single release gate.
- CI workflows are under `.github/workflows/`.
- `Dockerfile` and `docker-compose.yml` are included for containerized runs.
- Published on npm as [`@j0hanz/fetch-url-mcp`](https://www.npmjs.com/package/@j0hanz/fetch-url-mcp).

## Troubleshooting

| Symptom                                       | Likely Cause                        | Fix                                                                           |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Server output mixes with MCP traffic on stdio | Logs going to stdout                | Ensure all logging writes to stderr; the server does this by default.         |
| HTTP mode returns `403`                       | Host/origin mismatch                | Add the domain to `ALLOWED_HOSTS` or verify loopback bindings.                |
| HTTP mode returns `401`                       | Missing or invalid token            | Set `ACCESS_TOKENS` or configure OAuth env vars for remote bindings.          |
| Fetch returns private-IP error                | SSRF protections blocked the target | Set `ALLOW_LOCAL_FETCH=true` if the target is intentionally local.            |
| `truncated: true` in response                 | Content exceeded inline limits      | Increase `MAX_INLINE_CONTENT_CHARS` or accept truncated output.               |
| Transform timeout or worker crash             | Large or complex HTML               | Tune `TRANSFORM_WORKER_MAX_OLD_GENERATION_MB` or increase `FETCH_TIMEOUT_MS`. |
| Client config not working                     | Wrong config format for the client  | Check the matching `<details>` block above — config keys vary by client.      |

## Credits

| Dependency                                                                           | Registry |
| ------------------------------------------------------------------------------------ | -------- |
| [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | npm      |
| [@mozilla/readability](https://www.npmjs.com/package/@mozilla/readability)           | npm      |
| [linkedom](https://www.npmjs.com/package/linkedom)                                   | npm      |
| [node-html-markdown](https://www.npmjs.com/package/node-html-markdown)               | npm      |
| [undici](https://www.npmjs.com/package/undici)                                       | npm      |
| [zod](https://www.npmjs.com/package/zod)                                             | npm      |

## Contributing and License

Pull requests welcome. Please make sure these pass before submitting:

1. `npm run lint` and `npm run type-check`
2. `npm test`
3. `npm run format`

## License

MIT License. See [LICENSE](LICENSE) for details.
