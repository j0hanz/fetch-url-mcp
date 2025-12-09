# superFetch

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0.4-purple.svg)](https://modelcontextprotocol.io/)

**Intelligent web content fetcher MCP server that converts HTML to clean, AI-readable JSONL format.**

superFetch is a Model Context Protocol (MCP) server that enables AI assistants to fetch, extract, and transform web content into structured formats optimized for language model consumption. It uses Mozilla Readability for intelligent content extraction and supports both JSONL and Markdown output formats.

## Features

- 🌐 **Smart Content Extraction** - Uses Mozilla Readability to extract main article content, removing ads, navigation, and boilerplate
- 📄 **Multiple Output Formats** - JSONL (semantic blocks) or clean Markdown with YAML frontmatter
- 🔗 **Link Extraction** - Extract and classify internal/external links from any webpage
- ⚡ **Built-in Caching** - Configurable caching layer for improved performance
- 🛡️ **Security First** - SSRF protection, URL validation, and blocked private IP ranges
- 🔄 **Retry Logic** - Exponential backoff with jitter for resilient fetching
- 📊 **Server Statistics** - Resource endpoint for monitoring cache performance and server health
- 🎯 **MCP Prompts** - Pre-built prompts for common web content analysis tasks

## Technology Stack

| Category            | Technology                | Version       |
| ------------------- | ------------------------- | ------------- |
| Runtime             | Node.js                   | ≥18.0.0       |
| Language            | TypeScript                | 5.9           |
| MCP SDK             | @modelcontextprotocol/sdk | 1.0.4         |
| HTTP Server         | Express                   | 4.21          |
| Content Extraction  | @mozilla/readability      | 0.6.0         |
| HTML Parsing        | Cheerio, JSDOM            | 1.0.0, 25.0.1 |
| Markdown Conversion | Turndown                  | 7.2.0         |
| HTTP Client         | Axios                     | 1.7.9         |
| Caching             | node-cache                | 5.1.2         |
| Validation          | Zod                       | 3.25          |
| Logging             | Winston                   | 3.19          |
| Linting             | ESLint                    | 9.39          |
| Formatting          | Prettier                  | 3.7           |

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Clients                               │
│                  (Claude Desktop, VS Code, etc.)                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    superFetch MCP Server                         │
├─────────────────────────────────────────────────────────────────┤
│  Transport Layer                                                 │
│  ├── HTTP (Streamable HTTP Transport) - Port 3000               │
│  └── stdio (Direct integration mode)                            │
├─────────────────────────────────────────────────────────────────┤
│  Middleware                                                      │
│  ├── Rate Limiter (100 req/min)                                 │
│  ├── CORS Handler                                                │
│  └── Error Handler                                               │
├─────────────────────────────────────────────────────────────────┤
│  MCP Features                                                    │
│  ├── Tools: fetch-url, fetch-links, fetch-markdown              │
│  ├── Resources: superfetch://stats                              │
│  └── Prompts: analyze-web-content, summarize-page, extract-data │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                        │
│  ├── Fetcher (Axios + retry logic)                              │
│  ├── Extractor (Readability)                                    │
│  ├── Parser (Cheerio - semantic blocks)                         │
│  ├── Cache (node-cache)                                         │
│  └── Logger (Winston)                                           │
├─────────────────────────────────────────────────────────────────┤
│  Transformers                                                    │
│  ├── JSONL Transformer (semantic content blocks)                │
│  └── Markdown Transformer (Turndown + frontmatter)              │
└─────────────────────────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/superFetch.git
cd superFetch

# Install dependencies
npm install

# Build the project
npm run build
```

### Running the Server

**HTTP Mode (default):**

```bash
# Development with hot reload
npm run dev

# Production
npm start
```

The server will start at `http://127.0.0.1:3000` with:

- Health check: `GET /health`
- MCP endpoint: `POST /mcp`

**stdio Mode (for direct MCP integration):**

```bash
node dist/index.js --stdio
```

### Configuration

superFetch can be configured via environment variables:

| Variable             | Default            | Description                           |
| -------------------- | ------------------ | ------------------------------------- |
| `PORT`               | 3000               | HTTP server port                      |
| `HOST`               | 127.0.0.1          | HTTP server host                      |
| `FETCH_TIMEOUT`      | 30000              | Request timeout in ms (1s-120s)       |
| `MAX_REDIRECTS`      | 5                  | Maximum HTTP redirects (0-20)         |
| `USER_AGENT`         | superFetch-MCP/1.0 | HTTP User-Agent header                |
| `MAX_CONTENT_LENGTH` | 10485760           | Max response size in bytes (1KB-50MB) |
| `CACHE_ENABLED`      | true               | Enable response caching               |
| `CACHE_TTL`          | 3600               | Cache TTL in seconds (1min-24hr)      |
| `CACHE_MAX_KEYS`     | 100                | Maximum cache entries (10-10000)      |
| `LOG_LEVEL`          | info               | Logging level                         |
| `ENABLE_LOGGING`     | true               | Enable logging                        |

### MCP Client Configuration

Add superFetch to your MCP client configuration:

**Claude Desktop (`claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "superFetch": {
      "command": "node",
      "args": ["/path/to/superFetch/dist/index.js", "--stdio"]
    }
  }
}
```

**VS Code (HTTP mode):**

```json
{
  "mcpServers": {
    "superFetch": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Project Structure

```text
superFetch/
├── src/
│   ├── index.ts              # Entry point (HTTP/stdio server)
│   ├── server.ts             # MCP server factory
│   ├── config/
│   │   └── index.ts          # Configuration management
│   ├── errors/
│   │   ├── app-error.ts      # Custom error classes
│   │   └── index.ts
│   ├── middleware/
│   │   ├── error-handler.ts  # Express error middleware
│   │   └── rate-limiter.ts   # Request rate limiting
│   ├── prompts/
│   │   └── index.ts          # MCP prompt definitions
│   ├── resources/
│   │   └── index.ts          # MCP resource definitions
│   ├── services/
│   │   ├── cache.ts          # Caching service
│   │   ├── extractor.ts      # Content extraction (Readability)
│   │   ├── fetcher.ts        # HTTP fetching with retry
│   │   ├── logger.ts         # Winston logger
│   │   └── parser.ts         # HTML parsing (Cheerio)
│   ├── tools/
│   │   ├── index.ts          # Tool registration
│   │   └── handlers/
│   │       ├── fetch-url.tool.ts      # Main fetch tool
│   │       ├── fetch-links.tool.ts    # Link extraction
│   │       └── fetch-markdown.tool.ts # Markdown output
│   ├── transformers/
│   │   ├── jsonl.transformer.ts    # JSONL output format
│   │   └── markdown.transformer.ts # Markdown output format
│   ├── types/
│   │   ├── content.types.ts  # Content block types
│   │   ├── schemas.ts        # Input schemas
│   │   └── index.ts
│   └── utils/
│       ├── sanitizer.ts      # Text sanitization
│       └── url-validator.ts  # URL validation & SSRF protection
├── tests/
│   ├── unit/                 # Unit tests
│   └── integration/          # Integration tests
├── logs/                     # Log files (auto-created)
├── dist/                     # Compiled output
└── .github/
    ├── agents/               # AI agent configurations
    └── prompts/              # Prompt templates
```

## Key Features

### MCP Tools

#### `fetch-url`

Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks.

```typescript
{
  url: string;                    // URL to fetch (required)
  extractMainContent?: boolean;   // Use Readability extraction (default: true)
  includeMetadata?: boolean;      // Include page metadata (default: true)
  maxContentLength?: number;      // Max content length in characters
  format?: 'jsonl' | 'markdown';  // Output format (default: 'jsonl')
  customHeaders?: Record<string, string>; // Custom HTTP headers
}
```

#### `fetch-links`

Extracts all hyperlinks from a webpage with anchor text and type classification.

```typescript
{
  url: string;              // URL to extract links from (required)
  includeExternal?: boolean; // Include external links (default: true)
  includeInternal?: boolean; // Include internal links (default: true)
}
```

#### `fetch-markdown`

Fetches a webpage and converts it to clean Markdown format with optional frontmatter.

```typescript
{
  url: string;                  // URL to fetch (required)
  extractMainContent?: boolean; // Extract main content (default: true)
  includeMetadata?: boolean;    // Include YAML frontmatter (default: true)
}
```

### Content Block Types (JSONL)

- `metadata` - Page metadata (title, description, author, URL, timestamp)
- `heading` - Headings (h1-h6) with level
- `paragraph` - Text paragraphs
- `list` - Ordered/unordered lists
- `code` - Code blocks with optional language
- `table` - Tables with headers and rows
- `image` - Images with src and alt text

### MCP Resources

- `superfetch://stats` - Server statistics and cache performance metrics

### MCP Prompts

- `analyze-web-content` - Analyze fetched content with optional focus area
- `summarize-page` - Fetch and summarize a webpage concisely
- `extract-data` - Extract structured data from a webpage

## Development Workflow

### Available Scripts

| Script               | Description                              |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Start development server with hot reload |
| `npm run build`      | Compile TypeScript to JavaScript         |
| `npm start`          | Run compiled production server           |
| `npm run lint`       | Run ESLint                               |
| `npm run lint:fix`   | Fix ESLint issues automatically          |
| `npm run type-check` | Run TypeScript type checking             |
| `npm run format`     | Format code with Prettier                |
| `npm run knip`       | Find unused dependencies/exports         |

### VS Code Tasks

Pre-configured tasks available via `Ctrl+Shift+B`:

- **build** - Compile TypeScript (default build task)
- **dev** - Start development server
- **test** - Run tests
- **lint** - Run ESLint
- **type-check** - TypeScript type checking
- **lint-and-typecheck** - Run both lint and type-check

## Coding Standards

### TypeScript Configuration

- **Target**: ES2022
- **Module**: Node16
- **Strict mode**: Enabled
- **Declaration files**: Generated

### ESLint Rules

- Strict TypeScript rules enabled for `src/` directory
- No explicit `any` types
- No unsafe assignments, member access, calls, or returns
- No non-null assertions
- Unused variables must be prefixed with `_`

### Prettier Configuration

- Semicolons: Yes
- Single quotes: Yes
- Tab width: 2 spaces
- Trailing commas: ES5
- Print width: 80 characters
- LF line endings

### Error Handling

Custom error classes with HTTP status codes:

- `AppError` - Base error class
- `ValidationError` (400) - Input validation errors
- `UrlValidationError` (400) - Invalid or blocked URLs
- `FetchError` (502) - Network/HTTP errors
- `ExtractionError` (422) - Content extraction failures
- `RateLimitError` (429) - Rate limit exceeded
- `TimeoutError` (408/504) - Request timeout

## Testing

```bash
# Run all tests
npm test

# Manual testing with the test script
node test-fetch.mjs
```

The test script (`test-fetch.mjs`) validates:

- Server health check
- MCP session initialization
- Tool listing
- URL fetching (JSONL output)
- Cache behavior
- Server statistics resource

## Security

### SSRF Protection

The server blocks requests to:

- Localhost and loopback addresses
- Private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
- Cloud metadata endpoints (AWS, GCP, Azure)
- IPv6 link-local and unique local addresses

### Header Sanitization

Blocked headers in custom requests:

- `host`, `authorization`, `cookie`
- `x-forwarded-for`, `x-real-ip`
- `proxy-authorization`

### Rate Limiting

- Default: 100 requests per minute per IP
- Configurable window and max requests
- Automatic cleanup of expired entries

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Follow the coding standards and ensure all lints pass
4. Write tests for new functionality
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Code Review Checklist

- [ ] TypeScript strict mode compliance
- [ ] ESLint passes without warnings
- [ ] Prettier formatting applied
- [ ] Error handling with appropriate error classes
- [ ] Documentation updated if needed
- [ ] Tests added/updated
