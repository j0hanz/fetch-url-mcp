# 🚀 superFetch MCP Server

<img src="docs/logo.png" alt="SuperFetch MCP Logo" width="200">

[![npm version](https://img.shields.io/npm/v/@j0hanz/superfetch.svg)](https://www.npmjs.com/package/@j0hanz/superfetch) [![Node.js](https://img.shields.io/badge/Node.js-≥20.0.0-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D) [![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=superfetch&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Fsuperfetch%40latest%22%2C%22--stdio%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=superfetch&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovc3VwZXJmZXRjaEBsYXRlc3QiLCItLXN0ZGlvIl19)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that fetches, extracts, and transforms web content into AI-optimized formats using Mozilla Readability.

**Version:** 1.0.5

[Quick Start](#quick-start) · [How to Choose a Tool](#-how-to-choose-a-tool) · [Tools](#available-tools) · [Configuration](#configuration) · [Contributing](#contributing)

> 📦 **Published to [MCP Registry](https://registry.modelcontextprotocol.io/)** — Search for `io.github.j0hanz/superfetch`

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

## 🎯 How to Choose a Tool

Use this guide to select the right tool for your web content extraction needs:

### Decision Tree

```text
Need web content for AI?
├─ Single URL?
│   ├─ Need structured semantic blocks → fetch-url (JSONL)
│   ├─ Need readable markdown → fetch-markdown
│   └─ Need links only → fetch-links
└─ Multiple URLs?
    └─ Use fetch-urls (batch processing)
```

### Quick Reference Table

| Tool             | Best For                         | Output Format           | Use When                                    |
| ---------------- | -------------------------------- | ----------------------- | ------------------------------------------- |
| `fetch-url`      | Single page → structured content | JSONL semantic blocks   | AI analysis, RAG pipelines, content parsing |
| `fetch-markdown` | Single page → readable format    | Clean Markdown + TOC    | Documentation, human-readable output        |
| `fetch-links`    | Link discovery & classification  | URL array with types    | Sitemap building, finding related pages     |
| `fetch-urls`     | Batch processing multiple pages  | Multiple JSONL/Markdown | Comparing pages, bulk extraction            |

### Common Use Cases

| Task                     | Recommended Tool                         | Why                                                  |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------- |
| Parse a blog post for AI | `fetch-url`                              | Returns semantic blocks (headings, paragraphs, code) |
| Generate documentation   | `fetch-markdown`                         | Clean markdown with optional TOC                     |
| Build a sitemap          | `fetch-links`                            | Extracts and classifies all links                    |
| Compare multiple docs    | `fetch-urls`                             | Parallel fetching with concurrency control           |
| Extract article for RAG  | `fetch-url` + `extractMainContent: true` | Removes ads/nav, keeps main content                  |

---

## Quick Start

Add superFetch to your MCP client configuration — no installation required!

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

### With Environment Variables

```json
{
  "servers": {
    "superFetch": {
      "command": "npx",
      "args": ["-y", "@j0hanz/superfetch@latest", "--stdio"],
      "env": {
        "CACHE_TTL": "7200",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

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

> **Tip:** On Windows, if you encounter issues, try: `cmd /c "npx -y @j0hanz/superfetch@latest --stdio"`

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

# Run HTTP server
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

Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks.

| Parameter            | Type    | Default    | Description                                  |
| -------------------- | ------- | ---------- | -------------------------------------------- |
| `url`                | string  | _required_ | URL to fetch                                 |
| `extractMainContent` | boolean | `true`     | Use Readability to extract main content      |
| `includeMetadata`    | boolean | `true`     | Include page metadata (title, description)   |
| `maxContentLength`   | number  | –          | Maximum content length in characters         |
| `customHeaders`      | object  | –          | Custom HTTP headers for the request          |
| `timeout`            | number  | `30000`    | Request timeout in milliseconds (1000-60000) |
| `retries`            | number  | `3`        | Number of retry attempts (1-10)              |

**Example Response:**

```json
{
  "url": "https://example.com/article",
  "title": "Example Article",
  "fetchedAt": "2025-12-11T10:30:00.000Z",
  "contentBlocks": [
    {
      "type": "metadata",
      "title": "Example Article",
      "description": "A sample article"
    },
    { "type": "heading", "level": 1, "text": "Introduction" },
    {
      "type": "paragraph",
      "text": "This is the main content of the article..."
    },
    {
      "type": "code",
      "language": "javascript",
      "content": "console.log('Hello');"
    }
  ],
  "cached": false
}
```

### `fetch-links`

Extracts hyperlinks from a webpage with classification. Supports filtering, image links, and link limits.

| Parameter         | Type    | Default    | Description                                  |
| ----------------- | ------- | ---------- | -------------------------------------------- |
| `url`             | string  | _required_ | URL to extract links from                    |
| `includeExternal` | boolean | `true`     | Include external links                       |
| `includeInternal` | boolean | `true`     | Include internal links                       |
| `includeImages`   | boolean | `false`    | Include image links (img src attributes)     |
| `maxLinks`        | number  | –          | Maximum number of links to return (1-1000)   |
| `filterPattern`   | string  | –          | Regex pattern to filter links (matches href) |
| `customHeaders`   | object  | –          | Custom HTTP headers for the request          |
| `timeout`         | number  | `30000`    | Request timeout in milliseconds (1000-60000) |
| `retries`         | number  | `3`        | Number of retry attempts (1-10)              |

**Example Response:**

```json
{
  "url": "https://example.com/",
  "linkCount": 15,
  "links": [
    {
      "href": "https://example.com/about",
      "text": "About Us",
      "type": "internal"
    },
    {
      "href": "https://github.com/example",
      "text": "GitHub",
      "type": "external"
    },
    { "href": "https://example.com/logo.png", "text": "", "type": "image" }
  ],
  "cached": false,
  "truncated": false
}
```

### `fetch-markdown`

Fetches a webpage and converts it to clean Markdown with optional table of contents.

| Parameter            | Type    | Default    | Description                                  |
| -------------------- | ------- | ---------- | -------------------------------------------- |
| `url`                | string  | _required_ | URL to fetch                                 |
| `extractMainContent` | boolean | `true`     | Extract main content only                    |
| `includeMetadata`    | boolean | `true`     | Include YAML frontmatter                     |
| `maxContentLength`   | number  | –          | Maximum content length in characters         |
| `generateToc`        | boolean | `false`    | Generate table of contents from headings     |
| `customHeaders`      | object  | –          | Custom HTTP headers for the request          |
| `timeout`            | number  | `30000`    | Request timeout in milliseconds (1000-60000) |
| `retries`            | number  | `3`        | Number of retry attempts (1-10)              |

**Example Response:**

````json
{
  "url": "https://example.com/docs",
  "title": "Documentation",
  "fetchedAt": "2025-12-11T10:30:00.000Z",
  "markdown": "---\ntitle: Documentation\nsource: \"https://example.com/docs\"\n---\n\n# Getting Started\n\nWelcome to our documentation...\n\n## Installation\n\n```bash\nnpm install example\n```",
  "toc": [
    { "level": 1, "text": "Getting Started", "slug": "getting-started" },
    { "level": 2, "text": "Installation", "slug": "installation" }
  ],
  "cached": false,
  "truncated": false
}
````

### `fetch-urls` (Batch)

Fetches multiple URLs in parallel with concurrency control. Ideal for comparing content or processing multiple pages efficiently.

| Parameter            | Type     | Default    | Description                                  |
| -------------------- | -------- | ---------- | -------------------------------------------- |
| `urls`               | string[] | _required_ | Array of URLs to fetch (1-10 URLs)           |
| `extractMainContent` | boolean  | `true`     | Use Readability to extract main content      |
| `includeMetadata`    | boolean  | `true`     | Include page metadata                        |
| `maxContentLength`   | number   | –          | Maximum content length per URL in characters |
| `format`             | string   | `'jsonl'`  | Output format: `'jsonl'` or `'markdown'`     |
| `concurrency`        | number   | `3`        | Maximum concurrent requests (1-5)            |
| `continueOnError`    | boolean  | `true`     | Continue processing if some URLs fail        |
| `customHeaders`      | object   | –          | Custom HTTP headers for all requests         |
| `timeout`            | number   | `30000`    | Request timeout in milliseconds (1000-60000) |
| `retries`            | number   | `3`        | Number of retry attempts (1-10)              |

**Example Output:**

```json
{
  "results": [
    {
      "url": "https://example.com",
      "success": true,
      "title": "Example",
      "content": "...",
      "cached": false
    },
    {
      "url": "https://example.org",
      "success": true,
      "title": "Example Org",
      "content": "...",
      "cached": false
    }
  ],
  "summary": {
    "total": 2,
    "successful": 2,
    "failed": 0,
    "cached": 0,
    "totalContentBlocks": 15
  },
  "fetchedAt": "2024-12-11T10:30:00.000Z"
}
```

### Resources

| URI                   | Description                                         |
| --------------------- | --------------------------------------------------- |
| `superfetch://stats`  | Server statistics and cache metrics                 |
| `superfetch://health` | Real-time server health and dependency status       |
| Dynamic resources     | Cached content available via resource subscriptions |

### Prompts

- **`analyze-web-content`** — Analyze fetched content with optional focus area
- **`summarize-page`** — Fetch and summarize a webpage concisely
- **`extract-data`** — Extract structured data from a webpage

---

## Configuration

### Alternative MCP Client Setups

<details>
<summary><strong>VS Code (HTTP mode)</strong> — requires running server separately</summary>

First, start the HTTP server:

```bash
npx -y @j0hanz/superfetch@latest
```

Then add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "superFetch": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop (local path)</strong> — for development</summary>

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

### Environment Variables

| Variable               | Default              | Description                     |
| ---------------------- | -------------------- | ------------------------------- |
| `PORT`                 | `3000`               | HTTP server port                |
| `HOST`                 | `127.0.0.1`          | HTTP server host                |
| `FETCH_TIMEOUT`        | `30000`              | Request timeout (ms)            |
| `MAX_REDIRECTS`        | `5`                  | Maximum HTTP redirects          |
| `USER_AGENT`           | `superFetch-MCP/1.0` | HTTP User-Agent                 |
| `MAX_CONTENT_LENGTH`   | `10485760`           | Max response size (bytes)       |
| `CACHE_ENABLED`        | `true`               | Enable response caching         |
| `CACHE_TTL`            | `3600`               | Cache TTL (seconds)             |
| `CACHE_MAX_KEYS`       | `100`                | Maximum cache entries           |
| `LOG_LEVEL`            | `info`               | Logging level                   |
| `ENABLE_LOGGING`       | `true`               | Enable/disable logging          |
| `EXTRACT_MAIN_CONTENT` | `true`               | Extract main content by default |
| `INCLUDE_METADATA`     | `true`               | Include metadata by default     |
| `MAX_BLOCK_LENGTH`     | `5000`               | Maximum block length            |
| `MIN_PARAGRAPH_LENGTH` | `10`                 | Minimum paragraph length        |

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

### HTTP Mode Endpoints

When running without `--stdio`, the following endpoints are available:

| Endpoint  | Method | Description                             |
| --------- | ------ | --------------------------------------- |
| `/health` | GET    | Health check with uptime and version    |
| `/mcp`    | POST   | MCP request handling (requires session) |
| `/mcp`    | GET    | SSE stream for notifications            |
| `/mcp`    | DELETE | Close session                           |

Sessions are managed via `mcp-session-id` header with 30-minute TTL.

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
| `npm run release`    | Create new release                 |
| `npm run knip`       | Find unused exports/dependencies   |
| `npm run knip:fix`   | Auto-fix unused code               |

### Tech Stack

| Category           | Technology                        |
| ------------------ | --------------------------------- |
| Runtime            | Node.js ≥20.0.0                   |
| Language           | TypeScript 5.9                    |
| MCP SDK            | @modelcontextprotocol/sdk ^1.24.3 |
| Content Extraction | @mozilla/readability ^0.6.0       |
| HTML Parsing       | Cheerio ^1.1.2, JSDOM ^27.3.0     |
| Markdown           | Turndown ^7.2.2                   |
| HTTP               | Express ^5.2.1, Axios ^1.13.2     |
| Caching            | node-cache ^5.1.2                 |
| Validation         | Zod ^3.25.76                      |
| Logging            | Winston ^3.19.0                   |

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Ensure linting passes: `npm run lint`
4. Commit changes: `git commit -m 'Add amazing feature'`
5. Push: `git push origin feature/amazing-feature`
6. Open a Pull Request

For examples of other MCP servers, see: [github.com/modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
