# AGENTS.md

Fetch URL MCP Server — fetches public web pages and converts HTML to clean, AI-readable Markdown, served over MCP (stdio + Streamable HTTP transports).

## Commands

Run from the repo root.

### File-scoped (prefer these for fast feedback)

```bash
eslint --fix <file>        # lint and auto-fix one file
prettier --write <file>    # format one file
```

### Project-wide

```bash
npm run build              # clean → compile → copy assets (required before running or testing)
npm run type-check         # TypeScript type check, no emit
npm run lint               # ESLint (whole project)
npm run lint:fix           # ESLint with auto-fix
npm run format             # Prettier (whole project)
npm test                   # run test suite — requires build first
npm run inspector          # build + launch MCP Inspector for interactive testing
```

> **Tests import from `dist/`** — always `npm run build` before `npm test`.

## Safety and Permissions

**Always:**

- Use `.js` extensions on local ESM imports (`import { x } from './module.js'`)
- Write all logs and diagnostics to `stderr`; `stdout` is reserved for MCP JSON-RPC in stdio mode
- Return tool errors as `isError: true` in the tool result — never throw uncaught exceptions
- Use named exports only; no `default` exports

**Ask first before:**

- Installing new npm packages
- Changing env-var defaults or hardcoded limits in `src/config.ts`
- Modifying auth, session, or security logic in `src/http/native.ts`
- Changing the MCP public surface: tool input/output schemas, resource URIs, prompt names, or annotations
- Modifying the worker transform pipeline (`src/transform/transform.ts`, `src/transform/workers/`)

**Never:**

- Edit files in `dist/` or `node_modules/` directly (generated / vendor)
- Write to `stdout` from application code (corrupts the stdio MCP transport)
- Hard-code credentials, tokens, API keys, or secrets anywhere in source
- Fetch private or internal IPs — SSRF protection is mandatory; extend `src/ip-blocklist.ts` if adding new blocked ranges
- Bypass timing-safe comparison for auth tokens

## Key Source Files

| File                                       | Purpose                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/index.ts`                             | CLI entrypoint, transport selection, shutdown wiring (shebang required)       |
| `src/server.ts`                            | MCP server lifecycle, tool/resource/prompt registration                       |
| `src/tools.ts`                             | `fetch-url` tool definition and full fetch pipeline                           |
| `src/config.ts`                            | Env-driven configuration — single source of truth for all defaults and limits |
| `src/fetch.ts`                             | URL normalization, SSRF protection, HTTP fetch with redirect following        |
| `src/transform/transform.ts`               | Worker pool management, HTML-to-Markdown pipeline                             |
| `src/transform/workers/transform-child.ts` | Worker thread entrypoint (runs in isolation)                                  |
| `src/http/native.ts`                       | Streamable HTTP server, bearer/OAuth auth, session management                 |
| `src/cache.ts`                             | In-memory LRU cache for Markdown results                                      |
| `src/observability.ts`                     | Structured logging helpers (`logDebug`, `logWarn`, `logError`)                |

## Project Structure

```text
src/             TypeScript source (compiles to dist/)
  http/          Streamable HTTP transport (auth, health, rate-limit, helpers)
  transform/     HTML-to-Markdown pipeline (worker pool, types, workers)
  tasks/         Task lifecycle management (manager, execution, owner)
tests/           Tests — import from dist/, not src/
scripts/         Build and test orchestration (tasks.mjs)
assets/          Static assets (logo.svg)
examples/        Client usage examples
dist/            Compiled output (do not edit)
```

## PR / Change Checklist

1. `npm run type-check` — zero errors
2. `eslint --fix <changed-files>` — zero ESLint errors
3. `npm run build && npm test` — all tests pass
4. No `console.log` left in `src/` — use `logDebug` / `logError` from `src/observability.ts`
5. Diff is small and focused on one concern

## When Stuck

- Check `src/config.ts` for all configurable limits and env-var names before changing hardcoded values.
- Use `npm run inspector` to test MCP tool calls interactively without a full client.
- For TypeScript type errors involving Zod schemas, see `.github/instructions/typescript-mcp-server.instructions.md`.

## Further Reading

- TypeScript + MCP SDK conventions: [.github/instructions/typescript-mcp-server.instructions.md](.github/instructions/typescript-mcp-server.instructions.md)
