# AGENTS.md

> **Purpose:** Context and strict guidelines for AI agents working in this repository.

## 1. Project Context

- **Domain:** MCP server/CLI that fetches URLs, extracts readable content, and returns clean Markdown.
- **Tech Stack:**
  - **Language:** TypeScript 5.9 (Node.js ESM, Node >=20.18.1)
  - **Framework:** MCP SDK server + Express HTTP runtime
  - **Key Libraries:** @modelcontextprotocol/sdk, @mozilla/readability, node-html-markdown
- **Architecture:** Single-package MCP server with stdio and HTTP entrypoints.

## 2. Repository Map (High-Level Only)

- src/: Runtime source (CLI entry, HTTP server, MCP server, fetch/transform pipeline)
- tests/: Node test runner suite (uses built artifacts)
- docs/: Static assets
- .github/workflows/: Release and publish automation
  > _Note: Ignore dist, node_modules, .venv, and **pycache**._

## 3. Operational Commands

- **Environment:** Node.js >=20.18.1, npm
- **Install:** npm ci
- **Dev Server:** npm run dev
- **Test:** npm test (Prefer running only relevant tests)
- **Build:** npm run build

## 4. Coding Standards (Style & Patterns)

- **Naming:** camelCase for vars/functions, PascalCase for types
- **Structure:** Keep URL validation/fetching in fetch pipeline; keep entrypoints thin
- **Typing:** Strict TypeScript (noUncheckedIndexedAccess, exactOptionalPropertyTypes)
- **Preferred Patterns:**
  - Guard clauses/early returns for validation errors
  - Type-only imports with import { type X } and .js local import extensions

## 5. Agent Behavioral Rules (The "Do Nots")

- **Prohibited:** Do not use default exports; use named exports only.
- **Prohibited:** Do not use any; keep types explicit.
- **Prohibited:** Do not write non-protocol output to stdout in stdio mode.
- **Prohibited:** Do not edit lockfiles manually.
- **Handling Secrets:** Never output .env values or hardcode secrets.
- **File Creation:** Always verify folder existence before creating files.

## 6. Testing Strategy

- **Framework:** Node.js test runner (node:test)
- **Approach:** Tests run against dist/ build output; mock fetch for network isolation

## 7. Evolution & Maintenance

- **Update Rule:** If a convention changes or a new pattern is established, the agent MUST suggest an update to this file in the PR.
- **Feedback Loop:** If a build command fails twice, the correct fix MUST be recorded in the "Common Pitfalls" section.
