# 🚀 superFetch

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)[![Node.js](https://img.shields.io/badge/Node.js-≥18.0.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)[![MCP](https://img.shields.io/badge/MCP-1.0.4-8B5CF6?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=)](https://modelcontextprotocol.io/)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that fetches, extracts, and transforms web content into AI-optimized formats using Mozilla Readability.

[Installation](#installation) · [Tools](#available-tools) · [Configuration](#configuration) · [Contributing](#contributing)

---

> [!CAUTION]
> This server can access URLs on behalf of AI assistants. Built-in SSRF protection blocks private IP ranges and cloud metadata endpoints, but exercise caution when deploying in sensitive environments.

## ✨ Features

| Feature                   | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| 🧠 **Smart Extraction**   | Mozilla Readability removes ads, navigation, and boilerplate  |
| 📄 **Multiple Formats**   | JSONL semantic blocks or clean Markdown with YAML frontmatter |
| 🔗 **Link Discovery**     | Extract and classify internal/external links                  |
| ⚡ **Built-in Caching**   | Configurable TTL and max entries                              |
| 🛡️ **Security First**     | SSRF protection, URL validation, header sanitization          |
| 🔄 **Resilient Fetching** | Exponential backoff with jitter                               |
| 📊 **Monitoring**         | Stats resource for cache performance and health               |

---

## Installation

### Prerequisites

- **Node.js** ≥18.0.0
- **npm** or **yarn**

### Quick Start

```bash
git clone https://github.com/j0hanz/super-fetch-mcp-server.git
cd super-fetch-mcp-server
npm install
npm run build
```

### Running the Server

<details>
<summary><strong>HTTP Mode</strong> (default)</summary>

```bash
# Development with hot reload
npm run dev

# Production
npm start
```

Server runs at `http://127.0.0.1:3000`:

- Health check: `GET /health`
- MCP endpoint: `POST /mcp`

</details>

<details>
<summary><strong>stdio Mode</strong> (direct MCP integration)</summary>

```bash
node dist/index.js --stdio
```

</details>

---

## Available Tools

### `fetch-url`

Fetches a webpage and converts it to AI-readable format.

| Parameter            | Type                      | Default    | Description                |
| -------------------- | ------------------------- | ---------- | -------------------------- |
| `url`                | string                    | _required_ | URL to fetch               |
| `format`             | `'jsonl'` \| `'markdown'` | `'jsonl'`  | Output format              |
| `extractMainContent` | boolean                   | `true`     | Use Readability extraction |
| `includeMetadata`    | boolean                   | `true`     | Include page metadata      |
| `maxContentLength`   | number                    | –          | Max content length (chars) |
| `customHeaders`      | object                    | –          | Custom HTTP headers        |

### `fetch-links`

Extracts hyperlinks from a webpage with classification.

| Parameter         | Type    | Default    | Description               |
| ----------------- | ------- | ---------- | ------------------------- |
| `url`             | string  | _required_ | URL to extract links from |
| `includeExternal` | boolean | `true`     | Include external links    |
| `includeInternal` | boolean | `true`     | Include internal links    |

### `fetch-markdown`

Fetches a webpage and converts it to clean Markdown.

| Parameter            | Type    | Default    | Description               |
| -------------------- | ------- | ---------- | ------------------------- |
| `url`                | string  | _required_ | URL to fetch              |
| `extractMainContent` | boolean | `true`     | Extract main content only |
| `includeMetadata`    | boolean | `true`     | Include YAML frontmatter  |

### Resources

| URI                  | Description                         |
| -------------------- | ----------------------------------- |
| `superfetch://stats` | Server statistics and cache metrics |

### Prompts

- **`analyze-web-content`** — Analyze fetched content with optional focus area
- **`summarize-page`** — Fetch and summarize a webpage concisely
- **`extract-data`** — Extract structured data from a webpage

---

## Configuration

### MCP Client Setup

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "node",
      "args": ["/path/to/super-fetch-mcp-server/dist/index.js", "--stdio"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong> (HTTP mode)</summary>

Add to your user settings or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "superFetch": {
        "url": "http://127.0.0.1:3000/mcp"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong> (stdio mode)</summary>

```json
{
  "mcp": {
    "servers": {
      "superFetch": {
        "command": "node",
        "args": ["/path/to/super-fetch-mcp-server/dist/index.js", "--stdio"]
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable             | Default              | Description               |
| -------------------- | -------------------- | ------------------------- |
| `PORT`               | `3000`               | HTTP server port          |
| `HOST`               | `127.0.0.1`          | HTTP server host          |
| `FETCH_TIMEOUT`      | `30000`              | Request timeout (ms)      |
| `MAX_REDIRECTS`      | `5`                  | Maximum HTTP redirects    |
| `USER_AGENT`         | `superFetch-MCP/1.0` | HTTP User-Agent           |
| `MAX_CONTENT_LENGTH` | `10485760`           | Max response size (bytes) |
| `CACHE_ENABLED`      | `true`               | Enable response caching   |
| `CACHE_TTL`          | `3600`               | Cache TTL (seconds)       |
| `CACHE_MAX_KEYS`     | `100`                | Maximum cache entries     |
| `LOG_LEVEL`          | `info`               | Logging level             |

---

## Content Block Types

JSONL output includes semantic content blocks:

| Type        | Description                                     |
| ----------- | ----------------------------------------------- |
| `metadata`  | Page title, description, author, URL, timestamp |
| `heading`   | Headings (h1-h6) with level indicator           |
| `paragraph` | Text paragraphs                                 |
| `list`      | Ordered/unordered lists                         |
| `code`      | Code blocks with language                       |
| `table`     | Tables with headers and rows                    |
| `image`     | Images with src and alt text                    |

---

## Security

### SSRF Protection

Blocked destinations:

- Localhost and loopback addresses
- Private IP ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
- Cloud metadata endpoints (AWS, GCP, Azure)
- IPv6 link-local and unique local addresses

### Header Sanitization

Blocked headers: `host`, `authorization`, `cookie`, `x-forwarded-for`, `x-real-ip`, `proxy-authorization`

### Rate Limiting

Default: **100 requests/minute** per IP (configurable)

---

## Development

### Scripts

| Command              | Description                        |
| -------------------- | ---------------------------------- |
| `npm run dev`        | Development server with hot reload |
| `npm run build`      | Compile TypeScript                 |
| `npm start`          | Production server                  |
| `npm run lint`       | Run ESLint                         |
| `npm run type-check` | TypeScript type checking           |
| `npm run format`     | Format with Prettier               |
| `npm test`           | Run tests                          |

### Tech Stack

| Category           | Technology                      |
| ------------------ | ------------------------------- |
| Runtime            | Node.js ≥18                     |
| Language           | TypeScript 5.9                  |
| MCP SDK            | @modelcontextprotocol/sdk 1.0.4 |
| Content Extraction | @mozilla/readability            |
| HTML Parsing       | Cheerio, JSDOM                  |
| Markdown           | Turndown                        |
| HTTP               | Express, Axios                  |
| Caching            | node-cache                      |
| Validation         | Zod                             |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Ensure linting passes: `npm run lint`
4. Commit changes: `git commit -m 'Add amazing feature'`
5. Push: `git push origin feature/amazing-feature`
6. Open a Pull Request

For examples of other MCP servers, see: [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

---

## License

MIT License — see [LICENSE](LICENSE) for details.
