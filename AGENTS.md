# AGENTS.md

> Purpose: High-signal context and strict guidelines for AI agents working in this repository.

## 1) Project Context

- **Domain:** MCP (Model Context Protocol) server that fetches public web pages and converts HTML into clean, AI-readable Markdown — published as `@j0hanz/fetch-url-mcp` on npm and `io.github.j0hanz/fetch-url-mcp` on the MCP Registry (see `server.json`, `package.json`).
- **Tech Stack (Verified):**
  - **Language:** TypeScript 5.9+ (see `package.json` `devDependencies`, `tsconfig.json` strict config)
  - **Runtime:** Node.js >= 24 (see `package.json` `engines`, `.github/workflows/release.yml`)
  - **Framework:** `@modelcontextprotocol/sdk` ^1.26.0 — MCP server SDK v1.x (see `package.json` `dependencies`)
  - **Key Libraries:**
    - `zod` ^4.3.6 — input/output schema validation (see `package.json`)
    - `@mozilla/readability` ^0.6.0 — content extraction (see `package.json`)
    - `linkedom` ^0.18.12 — server-side DOM (see `package.json`)
    - `node-html-markdown` ^2.0.0 — HTML-to-Markdown conversion (see `package.json`)
- **Architecture:** Single-package MCP server exposing `fetch-url` tool via **stdio** (default) and **Streamable HTTP** transports. Entrypoint at `src/index.ts` wires CLI parsing, signal handlers, and transport selection. Server lifecycle managed in `src/server.ts` with tool registration in `src/tools.ts`. HTML fetching, URL normalization, and security (IP blocklist, SSRF protection) in `src/fetch.ts`. HTML → Markdown transformation optionally offloaded to a worker-thread pool (`src/workers/`). In-memory LRU caching in `src/cache.ts`.

## 2) Repository Map (High-Level)

- `src/` — TypeScript source (compiled to `dist/`); flat module structure, no subdirectories except `workers/` (see `tsconfig.json` `rootDir`)
  - `src/index.ts` — CLI entrypoint with shebang, transport wiring, shutdown handlers
  - `src/server.ts` — `McpServer` lifecycle: capabilities, icons, instructions, registration
  - `src/tools.ts` — `fetch-url` tool definition, input/output schemas, fetch pipeline, progress reporting, inline truncation
  - `src/fetch.ts` — URL normalization, SSRF protection, DNS validation, streaming HTTP fetch, raw-URL transforms (GitHub/GitLab/Bitbucket)
  - `src/transform.ts` — HTML-to-Markdown pipeline, worker-pool management
  - `src/workers/` — Worker-thread child for off-main-thread HTML transforms
  - `src/config.ts` — Centralized env-driven configuration
  - `src/errors.ts` — Error helpers (`FetchError`, `getErrorMessage`)
  - `src/mcp.ts` — MCP protocol handlers, task execution management
  - `src/resources.ts` — MCP resource/template registration (cache snapshots, instructions)
  - `src/prompts.ts` — MCP prompt registration (`get-help`)
  - `src/instructions.md` — Server instructions embedded at runtime
- `tests/` — Unit/integration tests (46+ test files) using Node.js built-in test runner
- `scripts/` — Build & test orchestration (`tasks.mjs`)
- `assets/` — Server icon (`logo.svg`)
- `.github/workflows/` — CI/CD (`release.yml`: lint → type-check → test → build → publish to npm, MCP Registry, Docker)

> Ignore: `dist/`, `node_modules/`, `coverage/`, `.cache/`, `.tsbuildinfo`

## 3) Operational Commands (Verified)

All commands verified from `.github/workflows/release.yml` (CI) and `package.json` scripts.

- **Environment:** Node.js >= 24 with npm; no additional runtime managers required (see `package.json` `engines`, `Dockerfile`)
- **Install:** `npm ci` (see `.github/workflows/release.yml` "Install & validate" step)
- **Dev:** `npm run dev` → `tsc --watch --preserveWatchOutput` (see `package.json`)
- **Dev (run):** `npm run dev:run` → `node --env-file=.env --watch dist/index.js` (see `package.json`)
- **Start:** `npm run start` → `node dist/index.js` (see `package.json`)
- **Build:** `npm run build` → `node scripts/tasks.mjs build` — cleans `dist/`, compiles TS, validates `instructions.md`, copies assets, sets executable bit (see `scripts/tasks.mjs`, `package.json`)
- **Type-check:** `npm run type-check` → `tsc -p tsconfig.json --noEmit` (see `scripts/tasks.mjs`, `.github/workflows/release.yml`)
- **Lint:** `npm run lint` → `eslint .` (see `package.json`, `.github/workflows/release.yml`)
- **Lint (fix):** `npm run lint:fix` → `eslint . --fix` (see `package.json`)
- **Format:** `npm run format` → `prettier --write .` (see `package.json`)
- **Test:** `npm run test` → `node scripts/tasks.mjs test` — builds first, then runs `node --test` on `tests/**/*.test.ts` (see `scripts/tasks.mjs`, `.github/workflows/release.yml`)
- **Test (coverage):** `npm run test:coverage` (see `package.json`)
- **Inspector:** `npm run inspector` → builds then launches MCP Inspector on stdio (see `package.json`)
- **Dead code:** `npm run knip` / `npm run knip:fix` (see `package.json`)
- **Docker:** `docker compose up --build` (see `docker-compose.yml`, `Dockerfile`)

## 4) Coding Standards (Style & Patterns)

### Naming (see `eslint.config.mjs` `@typescript-eslint/naming-convention`)

- **Default:** `camelCase` (leading `_` allowed)
- **Variables:** `camelCase`, `UPPER_CASE`, or `PascalCase`
- **Types/Interfaces:** `PascalCase`
- **Enum members:** `PascalCase` or `UPPER_CASE`
- **Properties:** unrestricted format
- **Imports:** `camelCase` or `PascalCase`

### Structure

- **Module system:** ESM (`"type": "module"` in `package.json`); use `.js` extensions in local imports (see `tsconfig.json` `module: "NodeNext"`, `.github/instructions/typescript-mcp-server.instructions.md`)
- **Exports:** Named exports only — no default exports (see `.github/instructions/typescript-mcp-server.instructions.md`)
- **Imports:** Type-only imports required (`import type { X }` / `import { type X }`) — enforced by `@typescript-eslint/consistent-type-imports` (see `eslint.config.mjs`)
- **Import order:** Automated via `@trivago/prettier-plugin-sort-imports` — `node:` → third-party → `@modelcontextprotocol` → `@mozilla` → local by layer (see `.prettierrc`)
- **No unused imports:** Enforced by `eslint-plugin-unused-imports` (see `eslint.config.mjs`)

### Typing/Strictness (see `tsconfig.json`)

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `noPropertyAccessFromIndexSignature: true`
- `exactOptionalPropertyTypes: true`
- `verbatimModuleSyntax: true`
- `isolatedModules: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `useUnknownInCatchVariables: true`
- ESLint extends `tseslint.configs.strictTypeChecked` + `stylisticTypeChecked` (see `eslint.config.mjs`)

### Formatting (see `.prettierrc`)

- 2-space indent, no tabs
- Single quotes, semicolons, trailing commas (`es5`)
- Print width: 80
- LF line endings
- Arrow parens: always

### Patterns Observed

- **Zod v4 strict schemas** for all tool inputs/outputs with `.describe()`, `.min()`/`.max()`, `z.strictObject()` (observed in `src/tools.ts`)
- **Structured + text content** responses: `structuredContent` always paired with `content: [{ type: 'text', text: JSON.stringify(structured) }]` for backward compatibility (observed in `src/tools.ts`)
- **Error handling:** Tool errors return `isError: true` in result — never throw uncaught; `FetchError` class with error codes (observed in `src/tools.ts`, `src/errors.ts`)
- **Class-based internal services** with injected dependencies (e.g., `IpBlocker`, `UrlNormalizer`, `RawUrlTransformer` in `src/fetch.ts`)
- **AsyncLocalStorage** for request-scoped context/observability (`runWithRequestContext` in `src/observability.ts`, used in `src/tools.ts`)
- **Worker-thread pool** for CPU-intensive HTML transforms with graceful scaling and shutdown (observed in `src/transform.ts`, `src/workers/`)
- **Explicit return types** on exported functions — enforced by `@typescript-eslint/explicit-function-return-type` (see `eslint.config.mjs`)
- **Shebang required:** `src/index.ts` must start with `#!/usr/bin/env node` (observed in `src/index.ts`, documented in `.github/instructions/typescript-mcp-server.instructions.md`)
- **Prefer arrow callbacks, const, template literals, destructuring, optional chaining, nullish coalescing** — all enforced via ESLint rules (see `eslint.config.mjs`)

## 5) Agent Behavioral Rules (Do Nots)

- Do not introduce new dependencies without updating `package.json` and `package-lock.json` via `npm install`. (see `package-lock.json` presence, `.github/workflows/release.yml` uses `npm ci`)
- Do not edit `package-lock.json` manually. (see `package-lock.json`)
- Do not commit secrets; never print `.env` values. Use environment variables via `config.ts`. (see `.gitignore` excludes `.env*`)
- Do not write non-MCP output to **stdout** in server code — it corrupts JSON-RPC on stdio transport. Use `console.error()` or protocol logging. (see `.github/instructions/typescript-mcp-server.instructions.md`)
- Do not use default exports. Use named exports only. (see `.github/instructions/typescript-mcp-server.instructions.md`)
- Do not use `any` — enforced by `@typescript-eslint/no-explicit-any: 'error'`. (see `eslint.config.mjs`)
- Do not disable or bypass existing lint/type rules without explicit approval. (see `eslint.config.mjs`, `tsconfig.json`)
- Do not use `zod/v3` compat mode — standardize on Zod v4. (see `.github/instructions/typescript-mcp-server.instructions.md`, `package.json`)
- Do not omit `.js` extensions in local imports. (see `tsconfig.json` `module: "NodeNext"`)
- Do not remove the shebang line (`#!/usr/bin/env node`) from `src/index.ts`. (see `.github/instructions/typescript-mcp-server.instructions.md`)
- Do not throw uncaught exceptions from tool handlers — return `isError: true` instead. (see `.github/instructions/typescript-mcp-server.instructions.md`)

## 6) Testing Strategy (Verified)

- **Framework:** Node.js built-in test runner (`node:test`) with `node:assert/strict` (see `scripts/tasks.mjs`, `tests/fetch-url-tool.test.ts`)
- **Where tests live:** `tests/` directory — 46+ `.test.ts` files (see repo tree)
- **Test patterns scanned:** `src/__tests__/**/*.test.ts`, `tests/**/*.test.ts` (see `scripts/tasks.mjs` `CONFIG.test.patterns`)
- **Approach:**
  - Tests import from compiled `../dist/` — a full build runs before tests (see `scripts/tasks.mjs` `TestTasks.test`, `tests/fetch-url-tool.test.ts` imports)
  - Unit tests with `globalThis.fetch` mocked via `t.mock.method()` (observed in `tests/fetch-url-tool.test.ts`)
  - Config values temporarily overridden per test with `try/finally` cleanup (observed in `tests/fetch-url-tool.test.ts`)
  - Worker pool shutdown in `after()` hooks for clean teardown (observed in `tests/fetch-url-tool.test.ts`)
  - No external services (DB/containers) required for tests
- **CI validation order:** `lint` → `type-check` → `test` → `build` (see `.github/workflows/release.yml`)

## 7) Common Pitfalls (Verified Only)

- Tests run against compiled output (`dist/`), not source — always build before testing. The `npm run test` command handles this automatically. (see `scripts/tasks.mjs`)
- `src/instructions.md` must exist — the build validates its presence and copies it to `dist/`. Missing it will fail the build. (see `scripts/tasks.mjs` `BuildTasks.validate`)
- Worker pool state is process-global — tests that change `config.transform.maxWorkerScale` must call `shutdownTransformWorkerPool()` before and/or after to avoid stale pool state. (observed in `tests/fetch-url-tool.test.ts`)
- Import sorting is enforced by Prettier plugin — manual import reordering will be overwritten by `npm run format`. (see `.prettierrc` `importOrder`)

## 8) Evolution Rules

- If conventions change, include an `AGENTS.md` update in the same PR.
- If a command is corrected after failures, record the final verified command here.
- If a new critical path or pattern is discovered, add it to the relevant section with evidence.
