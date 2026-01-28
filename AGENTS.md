# AGENTS.md

> Purpose: High-signal context and strict guidelines for AI agents working in this repository.

## 1) Project Context

- **Domain:** Intelligent web content fetcher MCP server (HTML to Markdown conversion).
- **Tech Stack (Verified):**
  - **Languages:** TypeScript 5.9.x (`package.json`), Node.js >=20 (`engines` in `package.json`).
  - **Frameworks:** Model Context Protocol SDK 1.25.x.
  - **Key Libraries:** `zod` (validation), `undici` (HTTP), `node-html-markdown` (transform), `linkedom` (DOM), `@mozilla/readability`.
- **Architecture:** Single-package MCP server with worker threads for transformation.

## 2) Repository Map (High-Level)

- `src/`: Application source code.
- `src/workers/`: Worker threads (e.g., `transform-worker.ts`).
- `tests/`: Test files (`*.test.ts`).
- `scripts/`: Build and utility scripts.
- `dist/`: Compiled JavaScript output (target for tests).
  > Ignore generated/vendor dirs like `dist/`, `node_modules/`.

## 3) Operational Commands (Verified)

- **Environment:** Node.js >=20.
- **Install:** `npm install`
- **Dev:** `npm run dev` (TSC watch) or `npm run dev:run` (Node watch `dist/`).
- **Test:** `npm test` (Builds first, then runs `node --test`).
- **Build:** `npm run build` (Clean + TSC + Assets + Make Executable).
- **Lint/Format:** `npm run lint` (ESLint), `npm run format` (Prettier).

## 4) Coding Standards (Style & Patterns)

- **Naming:** `kebab-case` for file names (verified in `src/` and `tests/`).
- **Structure:** Core logic in `src/` root; specialized tasks in subdirectories (`workers/`).
- **Typing/Strictness:** TypeScript strict mode enabled (`"strict": true` in `tsconfig.json`).
- **Patterns Observed:**
  - Imports use `NodeNext` resolution (e.g., `import ... from './file.js'`).
  - Worker threads used for heavy transformation tasks (`src/workers/transform-worker.ts`).

## 5) Agent Behavioral Rules (Do Nots)

- Do not introduce new dependencies without updating `package.json`.
- Do not edit `package-lock.json` manually.
- Do not bypass the build step when running tests; tests run against `dist/` artifacts.
- Do not commit secrets.
- Do not disable or bypass existing ESLint/TypeScript rules without explicit approval.

## 6) Testing Strategy (Verified)

- **Framework:** Node.js native test runner (`node --test`).
- **Where tests live:** `tests/*.test.ts`.
- **Approach:**
  - Tests import compiled code from `../dist/` (verified in `tests/mcp-server.test.ts`).
  - Requires `npm run build` before running tests (handled by `npm test`).

## 7) Common Pitfalls (Verified)

- **Test Failures due to Stale Build:** Tests run against `dist/`. If you modify `src/` and run `node --test tests/some.test.ts` directly without building, you will test old code. ALWAYS use `npm test` or build first.

## 8) Evolution Rules

- If conventions change, include an `AGENTS.md` update in the same PR.
- If a command is corrected after failures, record the final verified command here.
