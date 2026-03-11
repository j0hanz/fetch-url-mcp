# Fetch URL MCP Server

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffetch-url-mcp?style=flat-square&logo=npm)](https://www.npmjs.com/package/%40j0hanz%2Ffetch-url-mcp) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#contributing-and-license)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fetch-url&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22fetch-url-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffetch-url-mcp%40latest%22%5D%7D%7D)

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fetch-url&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmV0Y2gtdXJsLW1jcEBsYXRlc3QiXX0%3D) [![Install in Goose](https://block.github.io/goose/img/extension-install-dark.svg)](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=%40j0hanz%2Ffetch-url-mcp%40latest&id=%40j0hanz%2Ffetch-url-mcp&name=fetch-url&description=fetch-url%20MCP%20server)

A web content fetcher MCP server that converts HTML to clean, AI and human readable markdown.

## Overview

The Fetch URL MCP Server provides a standardized interface for fetching public web content and transforming it into Markdown enriched with structured metadata. It validates URLs, applies noise removal heuristics, and caches results for reuse. The server supports both inline and task-based execution modes, making it suitable for a wide range of client applications and LLM interactions.

## Key Features

- `fetch-url` validates public HTTP(S) URLs, fetches the page, and returns cleaned Markdown plus structured metadata.
- The tool advertises optional task support and emits progress updates while fetching and transforming larger pages.
- GitHub, GitLab, Bitbucket, and Gist page URLs are rewritten to raw-content endpoints when possible before fetch.
- `internal://instructions` and `internal://cache/{namespace}/{hash}` expose built-in guidance and cached Markdown as MCP resources.
- HTTP mode adds host/origin validation, auth, rate limiting, health checks, OAuth protected-resource metadata, and cached-download URLs.

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

[![Install in Goose](https://block.github.io/goose/img/extension-install-dark.svg)](https://block.github.io/goose/extension?cmd=npx&arg=-y&arg=%40j0hanz%2Ffetch-url-mcp%40latest&id=%40j0hanz%2Ffetch-url-mcp&name=fetch-url&description=A%20web%20content%20fetcher%20MCP%20server%20that%20converts%20HTML%20to%20clean%2C%20AI%20and%20human%20readable%20markdown.)

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

- Fetch documentation pages, blog posts, or reference material into Markdown before sending them to an LLM.
- Retrieve repository-hosted content from GitHub, GitLab, Bitbucket, or Gists and let the server rewrite page URLs to raw endpoints when possible.
- Reuse cached Markdown through `internal://cache/{namespace}/{hash}` or bypass the cache with `forceRefresh` for time-sensitive pages.
- Use task mode for large pages or slower sites when the inline response would otherwise be truncated or delayed.

## Architecture

```text
[MCP Client]
  ├─ stdio -> `src/index.ts` -> `startStdioServer()` -> `createMcpServer()`
  └─ HTTP (`--http`) -> `src/index.ts` -> `startHttpServer()` -> HTTP dispatcher
       ├─ `GET /health`
       ├─ `GET /.well-known/oauth-protected-resource`
       ├─ `GET /.well-known/oauth-protected-resource/mcp`
       ├─ `GET /mcp/downloads/{namespace}/{hash}`
       └─ `POST|GET|DELETE /mcp`

`createMcpServer()`
  ├─ registers tool: `fetch-url`
  ├─ registers prompt: `get-help`
  ├─ registers resources:
  │    - `internal://instructions`
  │    - `internal://cache/{namespace}/{hash}`
  ├─ enables capabilities: completions, logging, resources, prompts, tasks
  └─ installs task handlers, log-level handling, and shutdown cleanup

`fetch-url` execution
  ├─ validate input with `fetchUrlInputSchema`
  ├─ normalize URL and block local/private targets unless allowed
  ├─ rewrite supported code-host URLs to raw endpoints when possible
  ├─ fetch and cache content via the shared pipeline
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

Fetch public webpages and convert HTML into AI-readable Markdown. The tool is read-only, does not execute page JavaScript, can bypass the cache with `forceRefresh`, and supports optional task mode for larger or slower fetches.

| Parameter          | Type      | Required | Description                                                                                 |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------- |
| `url`              | `string`  | yes      | Target URL. Max 2048 chars.                                                                 |
| `skipNoiseRemoval` | `boolean` | no       | Preserve navigation/footers (disable noise filtering).                                      |
| `forceRefresh`     | `boolean` | no       | Bypass cache and fetch fresh content.                                                       |
| `maxInlineChars`   | `integer` | no       | Inline markdown limit (0-10485760, 0=unlimited). Lower of this or the global limit applies. |

The response is returned as MCP text content and, when validation succeeds, as `structuredContent` containing `url`, `resolvedUrl`, `finalUrl`, `title`, `metadata`, `markdown`, `fromCache`, `fetchedAt`, `contentSize`, and `truncated`.

```text
1. [Client] -- tools/call {name: "fetch-url", arguments} --> [Server]
2. [Server] -- dispatch("fetch-url") --> [src/tools/fetch-url.ts]
3. [Handler] -- validate(fetchUrlInputSchema) --> normalize / fetch / transform
4. [Handler] -- validate(fetchUrlOutputSchema) --> assemble content + structuredContent
5. [Server] -- result or tool error --> [Client]
```

### Resources

| Resource                     | URI                                   | MIME Type       | Description                                                   |
| ---------------------------- | ------------------------------------- | --------------- | ------------------------------------------------------------- |
| `fetch-url-mcp-instructions` | `internal://instructions`             | `text/markdown` | Guidance for using the Fetch URL MCP server.                  |
| `fetch-url-mcp-cache-entry`  | `internal://cache/{namespace}/{hash}` | `text/markdown` | Read cached markdown generated by previous `fetch-url` calls. |

### Prompts

| Prompt     | Arguments | Description                                                                                  |
| ---------- | --------- | -------------------------------------------------------------------------------------------- |
| `get-help` | none      | Return Fetch URL server instructions: workflows, cache usage, task mode, and error handling. |

## MCP Capabilities

| Capability                      | Status    | Notes                                                                                                                     |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| completions                     | confirmed | Advertised in `createServerCapabilities()` and used by the cache resource template for `namespace` and `hash` completion. |
| logging                         | confirmed | Advertised in `createServerCapabilities()` and handled through `SetLevelRequestSchema`.                                   |
| resources subscribe/listChanged | confirmed | Advertised in `createServerCapabilities()` and implemented for cache resource subscriptions and list changes.             |
| prompts                         | confirmed | `get-help` is registered during server startup.                                                                           |
| tasks                           | confirmed | Advertised in `createServerCapabilities()` and backed by registered task handlers plus optional tool task support.        |
| progress notifications          | confirmed | Tool execution reports `notifications/progress` updates during fetch and transform stages.                                |

### Tool Annotations

| Annotation        | Value   |
| ----------------- | ------- |
| `readOnlyHint`    | `true`  |
| `destructiveHint` | `false` |
| `idempotentHint`  | `true`  |
| `openWorldHint`   | `true`  |

### Structured Output

- `fetch-url` publishes an explicit `outputSchema` and returns `structuredContent` when the assembled response passes validation.

## Configuration

| Variable                                   | Default                   | Applies To        | Notes                                                                 |
| ------------------------------------------ | ------------------------- | ----------------- | --------------------------------------------------------------------- |
| `HOST`                                     | `127.0.0.1`               | HTTP mode         | Bind address. Non-loopback bindings also require `ALLOW_REMOTE=true`. |
| `PORT`                                     | `3000`                    | HTTP mode         | Listening port for `--http`.                                          |
| `ALLOW_REMOTE`                             | `false`                   | HTTP mode         | Must be enabled to bind to a non-loopback interface.                  |
| `ACCESS_TOKENS`                            | unset                     | HTTP mode         | Comma- or space-separated static bearer tokens.                       |
| `API_KEY`                                  | unset                     | HTTP mode         | Alternate static token source for header auth.                        |
| `OAUTH_ISSUER_URL`                         | unset                     | HTTP mode         | Enables OAuth mode when combined with the other OAuth URLs.           |
| `OAUTH_AUTHORIZATION_URL`                  | unset                     | HTTP mode         | Optional explicit authorization endpoint.                             |
| `OAUTH_TOKEN_URL`                          | unset                     | HTTP mode         | Optional explicit token endpoint.                                     |
| `OAUTH_REVOCATION_URL`                     | unset                     | HTTP mode         | Optional OAuth revocation endpoint.                                   |
| `OAUTH_REGISTRATION_URL`                   | unset                     | HTTP mode         | Optional OAuth dynamic client registration endpoint.                  |
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
| `ALLOW_LOCAL_FETCH`                        | `false`                   | Fetching          | Allows loopback and private-network fetch targets.                    |
| `FETCH_TIMEOUT_MS`                         | `15000`                   | Fetching          | Network fetch timeout in milliseconds.                                |
| `USER_AGENT`                               | `fetch-url-mcp/<version>` | Fetching          | Override the outbound user agent string.                              |
| `MAX_INLINE_CONTENT_CHARS`                 | `0`                       | Tool output       | `0` means no explicit inline truncation limit.                        |
| `CACHE_ENABLED`                            | `true`                    | Caching           | Enables in-memory fetch result caching.                               |
| `TASKS_MAX_TOTAL`                          | `5000`                    | Tasks             | Total task capacity.                                                  |
| `TASKS_MAX_PER_OWNER`                      | `1000`                    | Tasks             | Per-owner task cap, clamped to the total cap.                         |
| `TASKS_STATUS_NOTIFICATIONS`               | `false`                   | Tasks             | Enables status notifications for tasks.                               |
| `TASKS_REQUIRE_INTERCEPTION`               | `true`                    | Tasks             | Requires task interception for task-capable tool execution.           |
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
| `LOG_LEVEL`                                | `info`                    | Logging           | `debug`, `info`, `warn`, or `error`.                                  |
| `LOG_FORMAT`                               | `text`                    | Logging           | Set to `json` for structured logs.                                    |

## HTTP Endpoints

| Method   | Path                                        | Auth                                       | Purpose                                                 |
| -------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `GET`    | `/health`                                   | no, unless `?verbose=1` on a remote server | Basic health response, with optional diagnostics.       |
| `GET`    | `/.well-known/oauth-protected-resource`     | no                                         | OAuth protected-resource metadata.                      |
| `GET`    | `/.well-known/oauth-protected-resource/mcp` | no                                         | OAuth protected-resource metadata for the MCP endpoint. |
| `POST`   | `/mcp`                                      | yes                                        | Session initialization and JSON-RPC requests.           |
| `GET`    | `/mcp`                                      | yes                                        | Session-bound server-to-client stream handling.         |
| `DELETE` | `/mcp`                                      | yes                                        | Session shutdown.                                       |
| `GET`    | `/mcp/downloads/{namespace}/{hash}`         | yes                                        | Download route used by HTTP-mode cached fetch results.  |

## Security

| Control                    | Status      | Notes                                                                                                                                    |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host and origin validation | implemented | HTTP requests are rejected unless `Host` and `Origin` match the allowlist built from loopback, the configured host, and `ALLOWED_HOSTS`. |
| Authentication             | implemented | HTTP mode supports static bearer tokens locally or OAuth token introspection; remote bindings require OAuth.                             |
| Protocol version checks    | implemented | HTTP sessions validate `MCP-Protocol-Version` and pin it to the negotiated session version.                                              |
| Rate limiting              | implemented | Requests pass through the HTTP rate limiter before route dispatch.                                                                       |
| Outbound SSRF protections  | implemented | Local/private IPs, metadata endpoints, and `.local`/`.internal` hosts are blocked unless `ALLOW_LOCAL_FETCH=true`.                       |
| TLS                        | optional    | HTTPS is enabled when both TLS key and certificate files are configured.                                                                 |
| Stdio logging safety       | implemented | Server logs are written to stderr, not stdout, so stdio MCP traffic stays clean.                                                         |

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

- The repository includes release automation under `.github/workflows/`.
- `Dockerfile` and `docker-compose.yml` are available for container-based packaging and local runs.
- `npm run prepublishOnly` runs the release gate: lint, type-check, and build.

## Troubleshooting

- For stdio mode, avoid writing logs to stdout; keep logs on stderr.
- For HTTP mode, verify MCP protocol headers and endpoint routing.
- Update client snippets when client MCP configuration formats change.

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
