# Fetch URL MCP Server

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffetch-url-mcp?style=flat-square&logo=npm)](https://www.npmjs.com/package/%40j0hanz%2Ffetch-url-mcp) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#contributing-and-license)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22fetch-url-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D%7D)

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=fetch-url-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fetch-url-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D) [![Install in Goose](https://block.github.io/goose/img/extension-install-dark.svg)](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=%40j0hanz%2Ffetch-url-mcp%40latest&id=%40j0hanz%2Ffetch-url-mcp&name=fetch-url-mcp&description=fetch-url-mcp%20MCP%20server)

Intelligent web content fetcher MCP server that converts HTML to clean, AI-readable Markdown

## Overview

`@j0hanz/fetch-url-mcp` is an MCP server for fetching public web pages and converting them into cleaned Markdown. It exposes one read-only tool, one built-in help prompt, and one internal instructions resource. The default transport is stdio, and `--http` enables Streamable HTTP mode.

## Key Features

- `fetch-url` returns cleaned Markdown, metadata, redirect information, cache status, and structured output.
- The tool is explicitly annotated as read-only, idempotent, and open-world, with optional task support for large fetches.
- GitHub, GitLab, and Bitbucket page URLs are normalized to raw-content endpoints when appropriate.
- `get-help` exposes the server instructions, and `internal://instructions` makes the same guidance available as a resource.
- HTTP mode includes auth, host/origin validation, rate limiting, health checks, and OAuth protected-resource metadata routes.

## Requirements

- Node.js >=24 (from `package.json`)
- Docker is optional if you want to run the published container image.

## Quick Start

Use this standard MCP client configuration:

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

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
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

[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D&quality=insiders)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
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

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fetch-url-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D)

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

Add to `mcp.json (VS integrated)`:

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

For more info, see [Visual Studio MCP docs](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers).

</details>

<details>
<summary><b>Install in Goose</b></summary>

[![Install in Goose](https://block.github.io/goose/img/extension-install-dark.svg)](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=%40j0hanz%2Ffetch-url-mcp%40latest&id=%40j0hanz%2Ffetch-url-mcp&name=fetch-url-mcp&description=Intelligent%20web%20content%20fetcher%20MCP%20server%20that%20converts%20HTML%20to%20clean%2C%20AI-readable%20Markdown)

Add to `Goose extension registry`:

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

For more info, see [Goose MCP docs](https://block.github.io/goose/docs/getting-started/using-extensions).

</details>

<details>
<summary><b>Install in LM Studio</b></summary>

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=fetch-url-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D)

Add to `LM Studio MCP config`:

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

Add to `Claude Code CLI`:

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

Or install via CLI:

```sh
claude mcp add fetch-url-mcp -- npx -y @j0hanz/fetch-url-mcp@latest
```

For more info, see [Claude Code MCP docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/tutorials#set-up-model-context-protocol-mcp).

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

For more info, see [Windsurf MCP docs](https://docs.windsurf.com/windsurf/mcp).

</details>

<details>
<summary><b>Install in Amp</b></summary>

Add to `Amp MCP config`:

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

Or install via CLI:

```sh
amp mcp add fetch-url-mcp -- npx -y @j0hanz/fetch-url-mcp@latest
```

For more info, see [Amp MCP docs](https://docs.amp.dev).

</details>

<details>
<summary><b>Install in Cline</b></summary>

Add to `cline_mcp_settings.json`:

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

For more info, see [Cline MCP docs](https://docs.cline.bot/mcp-servers/configuring-mcp-servers).

</details>

<details>
<summary><b>Install in Codex CLI</b></summary>

Add to `~/.codex/config.yaml or codex CLI`:

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

For more info, see [Codex CLI MCP docs](https://github.com/openai/codex).

</details>

<details>
<summary><b>Install in GitHub Copilot</b></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fetch-url-mcp": {
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

Add to `Warp MCP config`:

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

For more info, see [Warp MCP docs](https://docs.warp.dev/features/mcp-model-context-protocol).

</details>

<details>
<summary><b>Install in Kiro</b></summary>

Add to `.kiro/settings/mcp.json`:

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

For more info, see [Kiro MCP docs](https://kiro.dev/docs/mcp/overview/).

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

For more info, see [Gemini CLI MCP docs](https://github.com/google-gemini/gemini-cli).

</details>

<details>
<summary><b>Install in Zed</b></summary>

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "fetch-url-mcp": {
      "settings": {
        "command": "npx",
        "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
      }
    }
  }
}
```

For more info, see [Zed MCP docs](https://zed.dev/docs/assistant/model-context-protocol).

</details>

<details>
<summary><b>Install in Augment</b></summary>

Add to `VS Code settings.json`:

> Add to your VS Code `settings.json` under `augment.advanced`.

```json
{
  "augment.advanced": {
    "mcpServers": [
      {
        "id": "fetch-url-mcp",
        "command": "npx",
        "args": ["-y", "@j0hanz/fetch-url-mcp@latest"]
      }
    ]
  }
}
```

For more info, see [Augment MCP docs](https://docs.augmentcode.com/setup-mcp-servers).

</details>

<details>
<summary><b>Install in Roo Code</b></summary>

Add to `Roo Code MCP settings`:

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

For more info, see [Roo Code MCP docs](https://docs.roocode.com/features/mcp/using-mcp-in-roo).

</details>

<details>
<summary><b>Install in Kilo Code</b></summary>

Add to `Kilo Code MCP settings`:

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

For more info, see [Kilo Code MCP docs](https://kilocode.ai/docs/features/mcp/using-mcp-servers).

</details>

## Use Cases

- Fetch documentation pages, blog posts, or reference material into Markdown before sending them to an LLM.
- Retrieve repository-hosted content from GitHub, GitLab, or Bitbucket and let the server rewrite page URLs to raw endpoints when possible.
- Force a fresh fetch for time-sensitive pages with `forceRefresh`, or preserve navigation and boilerplate with `skipNoiseRemoval`.
- Use MCP task mode for large pages or slower sites when the inline response would otherwise be truncated or delayed.

## Architecture

```text
[MCP Client]
  -> stdio -> `dist/index.js` -> `startStdioServer()` -> `createMcpServer()`
  -> HTTP -> `dist/index.js --http` -> `startHttpServer()` -> `/mcp`

`createMcpServer()`
  -> registers tool: `fetch-url`
  -> registers prompt: `get-help`
  -> registers resource: `internal://instructions`
  -> enables logging, resources notifications, prompts, and task handlers

HTTP request flow
  -> host/origin validation
  -> CORS handling
  -> rate limiting
  -> authentication
  -> health / OAuth metadata / download route dispatch
  -> MCP session gateway for `POST /mcp`, `GET /mcp`, `DELETE /mcp`

Tool execution flow
  -> validate input with `fetchUrlInputSchema`
  -> fetch via shared pipeline
  -> transform HTML to Markdown
  -> validate structured output with `fetchUrlOutputSchema`
  -> return text content plus `structuredContent`
```

### Request Lifecycle

```text
[Client] -- initialize {protocolVersion, capabilities} --> [Server]
[Server] -- {protocolVersion, capabilities, serverInfo} --> [Client]
[Client] -- notifications/initialized --> [Server]
[Client] -- tools/call {name, arguments} --> [Server]
[Server] -- {content: [{type, text}], isError?} --> [Client]
```

## MCP Surface

### Tools

#### `fetch-url`

Fetch public webpages and convert HTML into AI-readable Markdown. The tool is read-only, does not execute page JavaScript, can bypass cache with `forceRefresh`, and supports task mode for larger or slower fetches.

| Parameter          | Type      | Required | Description                                                                             |
| ------------------ | --------- | -------- | --------------------------------------------------------------------------------------- |
| `url`              | `string`  | yes      | Target URL. Max 2048 chars.                                                             |
| `skipNoiseRemoval` | `boolean` | no       | Preserve navigation/footers (disable noise filtering).                                  |
| `forceRefresh`     | `boolean` | no       | Bypass cache and fetch fresh content.                                                   |
| `maxInlineChars`   | `integer` | no       | Inline markdown limit (0-10485760, 0=unlimited). Lower of this or global limit applies. |

<details>
<summary>Data Flow</summary>

```text
1. Client calls `fetch-url` with `url` and optional fetch flags.
2. `fetchUrlInputSchema` validates the payload.
3. `performSharedFetch()` downloads the page and applies cache policy.
4. `markdownTransform()` converts the response body into Markdown and metadata.
5. The result is assembled into `content` plus `structuredContent`.
6. `fetchUrlOutputSchema` validates the structured payload before it is returned.
```

</details>

### Resources

| Resource                     | URI                       | MIME Type     | Description                                  |
| ---------------------------- | ------------------------- | ------------- | -------------------------------------------- |
| `fetch-url-mcp-instructions` | `internal://instructions` | text/markdown | Guidance for using the Fetch URL MCP server. |

### Prompts

| Prompt     | Arguments | Description                                                                                  |
| ---------- | --------- | -------------------------------------------------------------------------------------------- |
| `get-help` | none      | Return Fetch URL server instructions: workflows, cache usage, task mode, and error handling. |

## MCP Capabilities

| Capability                      | Status    | Evidence                                                                                                      |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| logging                         | confirmed | `createServerCapabilities()` advertises logging support and `SetLevelRequestSchema` is handled by the server. |
| resources subscribe/listChanged | confirmed | `createServerCapabilities()` enables resource subscriptions and list change notifications.                    |
| prompts                         | confirmed | `get-help` is registered during server startup.                                                               |
| tasks                           | confirmed | Task capabilities are advertised and task handlers are registered during startup.                             |
| progress notifications          | confirmed | Tool execution reports progress through the task/progress helpers.                                            |

### Tool Annotations

| Annotation        | Detected | Evidence                   |
| ----------------- | -------- | -------------------------- |
| `readOnlyHint`    | yes      | src/tools/fetch-url.ts:406 |
| `destructiveHint` | yes      | src/tools/fetch-url.ts:407 |
| `openWorldHint`   | yes      | src/tools/fetch-url.ts:409 |
| `idempotentHint`  | yes      | src/tools/fetch-url.ts:408 |

### Structured Output

- `fetch-url` publishes an explicit `outputSchema` and returns `structuredContent` when the output passes validation.

## Configuration

| Variable                                   | Default                   | Applies To        | Notes                                                                 |
| ------------------------------------------ | ------------------------- | ----------------- | --------------------------------------------------------------------- |
| `HOST`                                     | `127.0.0.1`               | HTTP mode         | Bind address. Non-loopback bindings also require `ALLOW_REMOTE=true`. |
| `PORT`                                     | `3000`                    | HTTP mode         | Listening port for `--http`.                                          |
| `ALLOW_REMOTE`                             | `false`                   | HTTP mode         | Must be enabled to bind to a non-loopback interface.                  |
| `ACCESS_TOKENS`                            | unset                     | HTTP mode         | Comma/space separated static bearer tokens.                           |
| `API_KEY`                                  | unset                     | HTTP mode         | Alternate static token source for header auth.                        |
| `OAUTH_ISSUER_URL`                         | unset                     | HTTP mode         | Enables OAuth mode when combined with the other OAuth URLs.           |
| `OAUTH_AUTHORIZATION_URL`                  | unset                     | HTTP mode         | Optional explicit authorization endpoint.                             |
| `OAUTH_TOKEN_URL`                          | unset                     | HTTP mode         | Optional explicit token endpoint.                                     |
| `OAUTH_INTROSPECTION_URL`                  | unset                     | HTTP mode         | Required for OAuth token introspection.                               |
| `OAUTH_REQUIRED_SCOPES`                    | empty                     | HTTP mode         | Required scopes enforced after auth.                                  |
| `OAUTH_CLIENT_ID`                          | unset                     | HTTP mode         | Optional introspection client ID.                                     |
| `OAUTH_CLIENT_SECRET`                      | unset                     | HTTP mode         | Optional introspection client secret.                                 |
| `SERVER_TLS_KEY_FILE`                      | unset                     | HTTP mode         | Enable HTTPS when set together with `SERVER_TLS_CERT_FILE`.           |
| `SERVER_TLS_CERT_FILE`                     | unset                     | HTTP mode         | TLS certificate path.                                                 |
| `SERVER_TLS_CA_FILE`                       | unset                     | HTTP mode         | Optional custom CA bundle.                                            |
| `SERVER_MAX_CONNECTIONS`                   | `0`                       | HTTP mode         | Optional connection cap.                                              |
| `SERVER_HEADERS_TIMEOUT_MS`                | unset                     | HTTP mode         | Optional Node server tuning.                                          |
| `SERVER_REQUEST_TIMEOUT_MS`                | unset                     | HTTP mode         | Optional Node server tuning.                                          |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS`             | unset                     | HTTP mode         | Optional keep-alive tuning.                                           |
| `SERVER_KEEP_ALIVE_TIMEOUT_BUFFER_MS`      | unset                     | HTTP mode         | Optional keep-alive tuning buffer.                                    |
| `SERVER_MAX_HEADERS_COUNT`                 | unset                     | HTTP mode         | Optional header count limit.                                          |
| `SERVER_BLOCK_PRIVATE_CONNECTIONS`         | `false`                   | HTTP mode         | Enables inbound private-network protections.                          |
| `MCP_STRICT_PROTOCOL_VERSION_HEADER`       | `true`                    | HTTP mode         | Requires `MCP-Protocol-Version` on session init.                      |
| `ALLOWED_HOSTS`                            | empty                     | HTTP mode         | Additional allowed `Host` and `Origin` values.                        |
| `ALLOW_LOCAL_FETCH`                        | `false`                   | Fetching          | Allows local/loopback fetch targets.                                  |
| `FETCH_TIMEOUT_MS`                         | `15000`                   | Fetching          | Network fetch timeout in milliseconds.                                |
| `MAX_INLINE_CONTENT_CHARS`                 | `0`                       | Tool output       | `0` means no explicit inline truncation limit.                        |
| `CACHE_ENABLED`                            | `true`                    | Caching           | Enables in-memory fetch result caching.                               |
| `TASKS_MAX_TOTAL`                          | `5000`                    | Tasks             | Total task capacity.                                                  |
| `TASKS_MAX_PER_OWNER`                      | `1000`                    | Tasks             | Per-owner task cap, clamped to the total cap.                         |
| `TASKS_STATUS_NOTIFICATIONS`               | `false`                   | Tasks             | Enables status notifications for tasks.                               |
| `TRANSFORM_CANCEL_ACK_TIMEOUT_MS`          | `200`                     | Transform workers | Cancellation acknowledgement timeout.                                 |
| `TRANSFORM_WORKER_MODE`                    | `threads`                 | Transform workers | Worker execution mode.                                                |
| `TRANSFORM_WORKER_MAX_OLD_GENERATION_MB`   | unset                     | Transform workers | Optional worker memory limit.                                         |
| `TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB` | unset                     | Transform workers | Optional worker memory limit.                                         |
| `TRANSFORM_WORKER_CODE_RANGE_MB`           | unset                     | Transform workers | Optional worker memory limit.                                         |
| `TRANSFORM_WORKER_STACK_MB`                | unset                     | Transform workers | Optional worker stack size.                                           |
| `FETCH_URL_MCP_EXTRA_NOISE_TOKENS`         | empty                     | Content cleanup   | Extra noise-removal tokens.                                           |
| `FETCH_URL_MCP_EXTRA_NOISE_SELECTORS`      | empty                     | Content cleanup   | Extra DOM selectors for noise removal.                                |
| `FETCH_URL_MCP_LOCALE`                     | system default            | Content cleanup   | Locale override for extraction heuristics.                            |
| `MARKDOWN_HEADING_KEYWORDS`                | built-in list             | Markdown cleanup  | Override heading keywords used by cleanup.                            |
| `USER_AGENT`                               | `fetch-url-mcp/<version>` | Fetching          | Override outbound user agent string.                                  |
| `LOG_LEVEL`                                | `info`                    | Logging           | `debug`, `info`, `warn`, or `error`.                                  |
| `LOG_FORMAT`                               | `text`                    | Logging           | `json` switches logger output format.                                 |

## HTTP Mode Endpoints

| Method   | Path                                        | Auth                                       | Purpose                                                 |
| -------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `GET`    | `/health`                                   | no, unless `?verbose=1` on a remote server | Basic health response, with optional diagnostics.       |
| `GET`    | `/.well-known/oauth-protected-resource`     | no                                         | OAuth protected-resource metadata.                      |
| `GET`    | `/.well-known/oauth-protected-resource/mcp` | no                                         | OAuth protected-resource metadata for the MCP endpoint. |
| `POST`   | `/mcp`                                      | yes                                        | Session initialization and JSON-RPC requests.           |
| `GET`    | `/mcp`                                      | yes                                        | Session-bound server-to-client stream handling.         |
| `DELETE` | `/mcp`                                      | yes                                        | Session shutdown.                                       |
| `GET`    | `/mcp/downloads/{namespace}/{hash}`         | yes                                        | Download route used by HTTP-mode fetch results.         |

## Security

| Control                    | Status      | Notes                                                                    |
| -------------------------- | ----------- | ------------------------------------------------------------------------ |
| Host and origin validation | implemented | HTTP requests are checked against an allowlist before dispatch.          |
| Authentication             | implemented | HTTP mode supports static bearer tokens or OAuth introspection.          |
| Protocol version checks    | implemented | Supported MCP protocol versions are validated on HTTP sessions.          |
| Rate limiting              | implemented | Requests pass through the HTTP rate limiter before route dispatch.       |
| TLS                        | optional    | HTTPS is enabled when both TLS key and certificate files are configured. |
| Stdio logging safety       | implemented | Server logs are written to stderr, not stdout.                           |

## Development

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

## Build and Release

- CI workflows detected: .github/workflows/docker-republish.yml, .github/workflows/release.yml
- Docker build signal detected (`Dockerfile` present).
- Publish/release script signal detected in `package.json`.

## Troubleshooting

- For stdio mode, avoid writing logs to stdout; keep logs on stderr.
- For HTTP mode, verify MCP protocol headers and endpoint routing.
- Re-run discovery and fact extraction after surface changes to keep documentation aligned.

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

- License: MIT
- Contributions are welcome via pull requests.
