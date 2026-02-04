# AGENTS.md

> Purpose: High-signal context and strict guidelines for AI agents working in this repository.

## 1) Project Context

- **Domain:** MCP server that fetches public web pages and converts HTML into clean Markdown. (evidence: README.md, src/instructions.md)
- **Tech Stack (Verified):**
  - **Languages:** TypeScript (compiled to `dist/`) on Node.js (engine constraint declared). (evidence: package.json, tsconfig.json)
  - **Frameworks:** Model Context Protocol (MCP) server using `@modelcontextprotocol/sdk`. (evidence: package.json, src/mcp.ts)
  - **Key Libraries:** `@modelcontextprotocol/sdk`, `@mozilla/readability`, `node-html-markdown`, `linkedom`, `undici`, `zod`. (evidence: package.json, src/transform.ts, src/fetch.ts)
- **Architecture:** Single-package Node/TS app with a CLI entrypoint that starts either stdio MCP or a Streamable HTTP server; core pipeline is fetch → extract → transform → return Markdown. (evidence: src/index.ts, src/mcp.ts, src/http-native.ts, src/fetch.ts, src/transform.ts)

## 2) Repository Map (High-Level)

- `[src/]`: Main server implementation (MCP wiring, HTTP server, fetch + transform pipeline). (evidence: tsconfig.json, src/index.ts, src/mcp.ts, src/http-native.ts, src/fetch.ts, src/transform.ts)
- `[src/workers/]`: Worker-thread transform worker implementation (used by transform pipeline). (evidence: src/transform.ts)
- `[tests/]`: Node test runner tests; tests import built artifacts from `dist/`. (evidence: tests/fetch-url-tool.test.ts)
- `[scripts/]`: Build orchestration and validation (TypeScript build, copying instructions/assets, making CLI executable). (evidence: scripts/tasks.mjs, package.json)
- `[assets/]`: Static assets copied to `dist/assets` during build. (evidence: scripts/tasks.mjs, README.md)
- `[.github/workflows/]`: CI/release workflow (build + lint + type-check + publish). (evidence: .github/workflows/publish.yml)

> Ignore generated/vendor dirs like `dist/`, `node_modules/`, coverage outputs, and local secrets. (evidence: .gitignore, tsconfig.json, .prettierignore)

## 3) Operational Commands (Verified)

- **Environment:** Node.js + npm; project declares `type: module` (ESM) and a Node engine constraint. (evidence: package.json)
- **Install:** `npm ci` (CI) or `npm install` (local/dev). (evidence: .github/workflows/publish.yml, README.md)
- **Dev:** `npm run dev` (tsc watch) and `npm run dev:run` (watch `dist/index.js` with `.env`). (evidence: package.json)
- **Test:** `npm test` (builds first, then runs Node’s test runner). (evidence: package.json)
- **Build:** `npm run build` (runs `node scripts/tasks.mjs`, compiling TS with `tsconfig.build.json` and copying required assets/instructions). (evidence: package.json, scripts/tasks.mjs, tsconfig.build.json)
- **Lint/Format:** `npm run lint`, `npm run lint:fix`, `npm run format`, `npm run type-check`. (evidence: package.json)

## 4) Coding Standards (Style & Patterns)

- **Naming:** TypeScript naming conventions are enforced via ESLint (e.g., `camelCase`, `PascalCase`, etc.). (evidence: eslint.config.mjs)
- **Structure:** TS sources live under `src/` and compile output goes to `dist/` with ESM module resolution (`NodeNext`). (evidence: tsconfig.json, package.json)
- **Typing/Strictness:** TypeScript `strict` is enabled along with additional strict flags (e.g., `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`). (evidence: tsconfig.json)
- **Formatting:** Prettier is configured with single quotes, LF line endings, 80 column width, and import sorting via `@trivago/prettier-plugin-sort-imports`. (evidence: .prettierrc)
- **Patterns Observed:**
  - Dual runtime modes (stdio MCP vs HTTP server) selected via CLI args. (evidence: src/index.ts, README.md, CONFIGURATION.md)
  - Server composition happens in `createMcpServer()` and is then connected to a transport (stdio or HTTP). (evidence: src/mcp.ts, src/http-native.ts)

## 5) Agent Behavioral Rules (Do Nots)

- Do not add/remove dependencies without updating `package.json` and keeping `package-lock.json` consistent (CI uses `npm ci`). (evidence: package.json, package-lock.json, .github/workflows/publish.yml)
- Do not bypass CI-quality gates: lint and type-check must stay green (CI runs them before build/publish). (evidence: .github/workflows/publish.yml, package.json)
- Do not commit secrets or local environment configs; `.env*` is explicitly gitignored. (evidence: .gitignore)
- Do not edit generated build output (`dist/`) as source of truth; update `src/` and rebuild instead (`outDir` is `dist`). (evidence: tsconfig.json, scripts/tasks.mjs, .gitignore)

## 6) Testing Strategy (Verified)

- **Framework:** Node’s built-in test runner (`node:test`) with `node:assert/strict`. (evidence: tests/fetch-url-tool.test.ts)
- **Where tests live:** `tests/` with `*.test.ts` style files. (evidence: tests/fetch-url-tool.test.ts)
- **Approach:** Tests execute against compiled output (imports from `../dist/...`), so a build is required before running tests directly. (evidence: tests/fetch-url-tool.test.ts, package.json)
- **Targeted runs:** Use the underlying runner used by `npm test` with a file filter, e.g. `node --test --experimental-transform-types tests/fetch-url-tool.test.ts` (the repo already uses `node --test` flags). (evidence: package.json)

## 7) Common Pitfalls (Optional; Verified Only)

- Running tests without building first can fail due to tests importing from `dist/` → run `npm test` (includes build) or `npm run build` first. (evidence: tests/fetch-url-tool.test.ts, package.json)
- HTTP mode requests must include `MCP-Protocol-Version` set to the expected value or requests will be rejected. (evidence: src/http-native.ts, CONFIGURATION.md)

## 8) Evolution Rules

- If conventions change, include an `AGENTS.md` update in the same PR. (evidence: AGENTS.md)
- If a command is corrected after failures, record the final verified command here. (evidence: AGENTS.md)
