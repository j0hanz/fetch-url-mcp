# AGENTS.md

> Purpose: High-signal context and strict guidelines for AI agents working in this repository.

## 1) Project Context

- **Domain:** MCP (Model Context Protocol) server that fetches web pages and converts HTML to clean, AI-readable Markdown.
- **Tech Stack (Verified):**
  - **Languages:** TypeScript 5.9+ (`package.json` → `"typescript": "^5.9.3"`), ESM (`"type": "module"`)
  - **Frameworks:** `@modelcontextprotocol/sdk` v1.x (`"^1.26.0"` in `package.json`), Node.js ≥24 (`engines`)
  - **Key Libraries:**
    - `zod` v4 (`"^4.3.6"`) — input/output schema validation
    - `@mozilla/readability` (`"^0.6.0"`) — article extraction
    - `linkedom` (`"^0.18.12"`) — DOM parsing (no browser required)
    - `node-html-markdown` (`"^2.0.0"`) — HTML→Markdown conversion
- **Architecture:** Single-package MCP server with modular source files (one concern per file). Supports both **stdio** and **Streamable HTTP** transports. Features an in-memory cache, task API, worker pool for transforms, IP blocklist, session management, and OAuth/static-token auth.

## 2) Repository Map (High-Level)

- `src/` — All production TypeScript source
  - `index.ts` — CLI entrypoint (shebang, arg parsing, transport selection, shutdown)
  - `mcp.ts` — McpServer creation, resource/tool registration, task handlers
  - `tools.ts` — `fetch-url` tool definition, pipeline, error mapping, progress reporting
  - `http-native.ts` — Streamable HTTP server (sessions, auth, health endpoint)
  - `config.ts` — Centralized env-based configuration (all settings)
  - `fetch.ts` — URL normalization, HTTP fetching
  - `transform.ts` / `workers/` — HTML→Markdown transform with worker pool
  - `cache.ts` — In-memory content cache with resource serving
  - `errors.ts` — `FetchError`, `getErrorMessage`, error helpers
  - `session.ts` — HTTP session store and lifecycle
  - `ip-blocklist.ts` — Private/metadata IP blocking
  - `observability.ts` — Structured logging with request context
- `tests/` — All test files (`*.test.ts`), run against compiled `dist/`
- `scripts/` — Build orchestration (`tasks.mjs`), validation scripts
- `assets/` — Static assets (logo SVG)
- `.github/workflows/` — CI/CD (publish to npm on release)
- `.github/instructions/` — Agent instruction files for MCP server conventions

> Ignore: `dist/`, `node_modules/`, `.tsbuildinfo`

## 3) Operational Commands (Verified)

- **Environment:** Node.js ≥24, npm
- **Install:** `npm ci` (CI from `publish.yml`) or `npm install`
- **Dev:** `npm run dev` (tsc watch) / `npm run dev:run` (run with .env + watch)
- **Build:** `npm run build` (clean → compile → validate instructions → copy assets → chmod; via `scripts/tasks.mjs`)
- **Test:** `npm test` (builds first, then runs `node --test` on `tests/**/*.test.ts` against compiled `dist/`)
- **Type-check:** `npm run type-check` (tsc --noEmit)
- **Lint:** `npm run lint` (ESLint) / `npm run lint:fix`
- **Format:** `npm run format` (Prettier)
- **Dead code:** `npm run knip` / `npm run knip:fix`
- **Inspector:** `npm run inspector` (build + launch MCP Inspector on stdio)

## 4) Coding Standards (Style & Patterns)

- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes/enums, `UPPER_CASE` for constants. Enforced via `@typescript-eslint/naming-convention` in `eslint.config.mjs`.
- **Imports:**
  - **Type-only imports required:** `import type { X }` / `import { type X }` (ESLint `consistent-type-imports` rule: error)
  - **Named exports only:** no default exports
  - `.js` extensions in local imports (NodeNext module resolution)
  - Sorted by `@trivago/prettier-plugin-sort-imports`
  - Unused imports are errors (`eslint-plugin-unused-imports`)
- **TypeScript Strictness** (all enabled in `tsconfig.json`):
  - `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`
  - `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **Explicit return types** required on functions (`explicit-function-return-type`: error)
- **No `any`:** `@typescript-eslint/no-explicit-any`: error
- **Schemas:** Use `z.strictObject()` for all Zod schemas; add `.describe()` to every parameter; add bounds (`.min()`/`.max()`)
- **Tool pattern:** One MCP tool per registration; return both `content` (JSON stringified text block) and `structuredContent`; use `isError: true` on failure (never throw uncaught)
- **Error handling:** Prefer tool execution errors over protocol errors; centralized via `getErrorMessage()`, `createToolErrorResponse()`, `handleToolError()` in `errors.ts`/`tools.ts`
- **Logging:** Never write to `stdout` in stdio mode; use `logInfo`/`logError`/`logWarn`/`logDebug` from `observability.ts` (writes to stderr)
- **Patterns Observed:**
  - Configuration via environment variables, parsed once at import in `config.ts`
  - Worker pool pattern for CPU-bound transforms (`src/workers/`, `src/transform.ts`)
  - Inline content truncation with safe code-fence closing (`tools.ts`)
  - Session-scoped task ownership for async tool execution (`mcp.ts`)

## 5) Agent Behavioral Rules (Do Nots)

- Do not introduce new dependencies without updating manifests/lockfiles via the package manager.
- Do not edit `package-lock.json` manually.
- Do not commit secrets; never print `.env` values; use existing `config.ts` env parsing.
- Do not change public APIs (tool schemas, MCP resource URIs) without updating docs/tests and noting migration impact.
- Do not disable or bypass existing ESLint/TypeScript rules without explicit approval.
- Do not use default exports; always use named exports.
- Do not use `any`; use `unknown` and narrow with type guards (`type-guards.ts`).
- Do not write to `stdout` in production code (corrupts JSON-RPC stdio transport); use `process.stderr` or observability helpers.
- Do not add `.js` extension-less local imports — NodeNext resolution requires `.js` extensions.
- Do not use Zod v3 APIs (`z.object()` → use `z.strictObject()`).
- Do not throw uncaught exceptions from tool handlers — return `isError: true` responses.

## 6) Testing Strategy (Verified)

- **Framework:** `node:test` (built-in Node.js test runner) + `node:assert/strict`
- **Where tests live:** `tests/` directory (all `*.test.ts` files)
- **Approach:**
  - Tests run against **compiled output** (`dist/`) — build is a prerequisite
  - Unit tests with `t.mock.method()` for mocking (`globalThis.fetch`, library methods)
  - No external test dependencies (no Jest, Vitest, etc.)
  - Patterns: describe/it blocks, setUp/tearDown via `after()`, config mutations restored in `finally`
  - ~45 test files covering tools, cache, transform, URL handling, HTTP server, sessions, errors, etc.
  - Coverage available via `npm run test:coverage` (`--experimental-test-coverage`)

## 7) Common Pitfalls (Verified)

- **Tests require build first** — `npm test` runs the build automatically, but if running `node --test` manually, ensure `dist/` is current.
- **CI uses Node 20 but `engines` requires ≥24** — local dev/tests must use Node ≥24; the publish workflow pins Node 20 for npm compatibility.
- **Config mutations in tests** — tests that modify `config.*` properties must restore original values in `finally` blocks to avoid leaking state across tests.
- **Worker pool shutdown** — tests using the transform pipeline should call `shutdownTransformWorkerPool()` in `after()` hooks to prevent hanging processes.
- **Shebang line** — `src/index.ts` must keep `#!/usr/bin/env node` as the exact first line (no BOM, no blank lines before it).

## 8) Evolution Rules

- If conventions change, include an `AGENTS.md` update in the same PR.
- If a command is corrected after failures, record the final verified command here.
