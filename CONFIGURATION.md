# Configuration Reference

SuperFetch is configured with environment variables. Set them in your MCP client configuration (the `env` field) or in the shell before starting the server.

## Where to Set Variables

Example MCP client config:

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

Codex IDE example (`config.toml`):

```toml
[mcp_servers.superfetch]
command = "npx"
args = ["-y", "@j0hanz/superfetch@latest", "--stdio"]
env = { CACHE_TTL = "7200", LOG_LEVEL = "debug", FETCH_TIMEOUT = "60000" }
```

## Parsing Rules

- Integer values are parsed with `parseInt`. Invalid or out-of-range values fall back to defaults.
- Booleans treat the string `false` (lowercase) as `false`; any other non-empty value is `true`. Unset or empty values use defaults.

## Runtime Modes

- Stdio mode: run with `--stdio`. No HTTP server is started.
- HTTP mode (default): requires `API_KEY` and starts an HTTP server.
- Binding to non-loopback hosts requires `ALLOW_REMOTE=true`.
- Host header validation is enforced; set `ALLOWED_HOSTS` when binding to `0.0.0.0` or `::`.

## Environment Variables

### HTTP Server

| Variable                  | Default     | Valid Values          | Description                                                                                                                       |
| ------------------------- | ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEY`                 | -           | -                     | Required for HTTP mode. Requests must include `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`.                        |
| `HOST`                    | `127.0.0.1` | Any valid hostname/IP | HTTP server host. Non-loopback hosts require `ALLOW_REMOTE=true`.                                                                 |
| `PORT`                    | `3000`      | `1024`-`65535`        | HTTP server port.                                                                                                                 |
| `ALLOW_REMOTE`            | `false`     | `true` / `false`      | Allow binding to non-loopback interfaces.                                                                                         |
| `ALLOWED_HOSTS`           | -           | Comma-separated list  | Allowed `Host` header values. Loopback hosts are always allowed; the configured `HOST` is allowed unless it is `0.0.0.0` or `::`. |
| `TRUST_PROXY`             | `false`     | `true` / `false`      | Enable Express `trust proxy`.                                                                                                     |
| `SESSION_TTL_MS`          | `1800000`   | `60000`-`86400000`    | Session TTL in milliseconds.                                                                                                      |
| `SESSION_INIT_TIMEOUT_MS` | `10000`     | `1000`-`60000`        | Time allowed for session initialization.                                                                                          |
| `MAX_SESSIONS`            | `200`       | `10`-`10000`          | Maximum active sessions.                                                                                                          |
| `REQUIRE_AUTH`            | `false`\*   | `true` / `false`      | Reserved for future use (currently unused).                                                                                       |

\*Default for `REQUIRE_AUTH` is `false` on loopback hosts and `true` otherwise, but it is not applied yet.

### Fetcher

| Variable        | Default              | Valid Values    | Description                      |
| --------------- | -------------------- | --------------- | -------------------------------- |
| `FETCH_TIMEOUT` | `30000`              | `5000`-`120000` | Request timeout in milliseconds. |
| `USER_AGENT`    | `superFetch-MCP/1.0` | Any string      | Custom `User-Agent` header.      |

Notes:

- HTML responses are capped at 10 MB; larger responses fail the request.

### Cache

| Variable         | Default | Valid Values     | Description                |
| ---------------- | ------- | ---------------- | -------------------------- |
| `CACHE_ENABLED`  | `true`  | `true` / `false` | Enable response caching.   |
| `CACHE_TTL`      | `3600`  | `60`-`86400`     | Cache lifetime in seconds. |
| `CACHE_MAX_KEYS` | `100`   | `10`-`1000`      | Maximum cached entries.    |

### Extraction

| Variable               | Default | Valid Values     | Description                                    |
| ---------------------- | ------- | ---------------- | ---------------------------------------------- |
| `EXTRACT_MAIN_CONTENT` | `true`  | `true` / `false` | Use Readability to extract main content.       |
| `INCLUDE_METADATA`     | `true`  | `true` / `false` | Include metadata/frontmatter where applicable. |

### Output and Inline Limits

| Variable                   | Default | Valid Values    | Description                                            |
| -------------------------- | ------- | --------------- | ------------------------------------------------------ |
| `MAX_INLINE_CONTENT_CHARS` | `20000` | `1000`-`200000` | Inline content limit before returning a resource link. |

### Logging

| Variable         | Default | Valid Values                        | Description                                                                     |
| ---------------- | ------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `LOG_LEVEL`      | `info`  | `debug` / `info` / `warn` / `error` | When `debug`, includes debug logs. Other levels are always logged when enabled. |
| `ENABLE_LOGGING` | `true`  | `true` / `false`                    | Enable/disable logging.                                                         |

### CORS (HTTP Mode)

| Variable          | Default | Description                              |
| ----------------- | ------- | ---------------------------------------- |
| `ALLOWED_ORIGINS` | `[]`    | Comma-separated list of allowed origins. |
| `CORS_ALLOW_ALL`  | `false` | Allow all origins (dev only).            |

If `ALLOWED_ORIGINS` is empty and `CORS_ALLOW_ALL` is `false`, no CORS headers are added.

### Rate Limiting (HTTP Mode)

| Variable                | Default | Valid Values      | Description                           |
| ----------------------- | ------- | ----------------- | ------------------------------------- |
| `RATE_LIMIT_ENABLED`    | `true`  | `true` / `false`  | Enable/disable HTTP rate limiting.    |
| `RATE_LIMIT_MAX`        | `100`   | `1`-`10000`       | Max requests per window per IP.       |
| `RATE_LIMIT_WINDOW_MS`  | `60000` | `1000`-`3600000`  | Rate limit window in milliseconds.    |
| `RATE_LIMIT_CLEANUP_MS` | `60000` | `10000`-`3600000` | Cleanup interval for limiter entries. |

Rate limiting is applied to `/mcp` and `/mcp/downloads` routes.

### Debug and Development

| Variable              | Default | Description                                                                                   |
| --------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | -       | When set to `development`, HTTP error responses include stack traces.                         |
| `EXPOSE_STACK_TRACES` | `false` | When `NODE_ENV=development` and `EXPOSE_STACK_TRACES=true`, tool errors include stack traces. |

## Configuration Presets

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

## Per-Request Overrides

Tool inputs can override several settings per request:

- `timeout` and `retries` override fetch behavior.
- `maxContentLength` caps the transformed output length (in characters).
- `customHeaders` are sanitized to remove disallowed headers.

See `README.md` for tool input schemas and examples.

## Examples

Enable HTTP mode on all interfaces (remember to set `ALLOWED_HOSTS`):

```bash
API_KEY=supersecret ALLOW_REMOTE=true HOST=0.0.0.0 ALLOWED_HOSTS=example.com,api.example.com npm start
```
