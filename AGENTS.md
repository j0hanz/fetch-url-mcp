# AGENTS.md

## Project Overview

- MCP server that fetches web pages, extracts readable content (Mozilla Readability), and returns AI-friendly Markdown.
- Tech: Node.js (ESM), TypeScript, Express (HTTP mode), Zod, undici, turndown.
- Runtime modes:
  - **stdio**: `--stdio` (MCP over stdin/stdout)
  - **HTTP** (default): requires `API_KEY`

## Repo Map / Structure

- `src/`: TypeScript source
  - `src/index.ts`: CLI entrypoint (build outputs `dist/index.js`; also used for `bin: superfetch`)
  - `src/http/`: HTTP server, auth, CORS, rate-limiting, MCP routes/session transport
  - `src/services/`: fetch pipeline, caching, extraction, logging
  - `src/tools/`: MCP tool schemas + handlers
  - `src/transformers/`: content transformers (e.g., Markdown)
  - `src/utils/`: URL validation, crypto helpers, error utils, truncation, etc.
- `tests/`: Node test runner tests (`*.test.ts` and `*.test.js`)
- `dist/`: build output (ignored by git, but published to npm)
- `scripts/`: local release helpers (`release.sh`, `release.bat`)
- `docs/`: project assets (currently `docs/logo.png`)

## Setup & Environment

- Node: `>=20.12.0` (see `package.json#engines`)
- Package manager: npm (repo includes `package-lock.json`)
- Install deps:
  - `npm install` (local dev)
  - `npm ci` (CI / clean install)
- Configuration:
  - Environment variables documented in `CONFIGURATION.md`
  - HTTP mode requires `API_KEY`

## Development Workflow

- Dev (hot reload): `npm run dev` (runs `tsx watch src/index.ts`)
- Build: `npm run build` (runs `tsc -p tsconfig.build.json`)
- Start (prod): `npm start` (runs `node dist/index.js`)
- Format: `npm run format` (Prettier)
- Inspector: `npm run inspector` (Model Context Protocol inspector)

## Testing

- All tests: `npm test` (builds, then runs `node --test --experimental-transform-types`)
- Coverage: `npm run test:coverage`
- Test locations/patterns:
  - Tests live in `tests/`
  - Filenames include `*.test.ts` and `*.test.js`

## Code Style & Conventions

- Language/TS:
  - TypeScript `^5.9.3`
  - ESM + `moduleResolution: NodeNext` (see `tsconfig.json`)
- Imports:
  - Local imports use `.js` extensions (NodeNext output/runtime expectation)
  - Prefer type-only imports (enforced by ESLint rules)
- Formatting:
  - Prettier: `npm run format`
  - Import sorting is enforced via `@trivago/prettier-plugin-sort-imports` (see `.prettierrc`)
- Lint:
  - `npm run lint`
  - Fix: `npm run lint:fix`
- Type checking:
  - `npm run type-check` (runs `tsc --noEmit`)
- Naming / strictness:
  - Naming conventions and unused imports/vars are enforced in `eslint.config.mjs`
  - TS strict options include `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc. (see `tsconfig.json`)

## Build / Release

- Build output: `dist/`
- Local release helpers:
  - `scripts/release.sh [patch|minor|major|version]`
  - `scripts/release.bat [patch|minor|major|version]`
  - These scripts bump `package.json` version, run `npm run lint`, `npm run type-check`, `npm run build`, then create a git commit and tag `vX.Y.Z`.
- CI releases:
  - Tag push `v*.*.*` triggers GitHub Actions release automation (see `.github/workflows/release.yml`).
  - Publishing can also run on GitHub Release publish event via Trusted Publishing/OIDC (see `.github/workflows/publish.yml`).

## Security & Safety

- This project fetches arbitrary URLs on behalf of clients.
- Built-in protections (documented in `README.md`):
  - URL validation (only `http`/`https`, no embedded credentials, max URL length)
  - SSRF protections via blocked IP ranges, blocked host suffixes, and DNS resolution checks
  - Header sanitization (blocks sensitive headers like `authorization`, `cookie`, `x-forwarded-for`, etc.)
- HTTP mode:
  - Requires `API_KEY` (bearer auth or `X-API-Key`)
  - Uses session management via `mcp-session-id` header
- When changing fetch/security behavior:
  - Prefer adding/adjusting tests in `tests/` and keep protections enabled by default.

## Pull Request / Commit Guidelines

- Before opening a PR, run:
  - `npm run lint`
  - `npm run type-check`
  - `npm test`
- Release scripts use commit message: `chore: release vX.Y.Z`.

## Troubleshooting

- `node --test --experimental-transform-types` emits an experimental warning; this is expected (see `README.md`).
- Windows env vars for HTTP mode (PowerShell):
  - `$env:API_KEY = "supersecret"; npx -y @j0hanz/superfetch@latest`
- If HTTP mode is used remotely:
  - Ensure host/origin/allowed hosts config matches deployment (see `CONFIGURATION.md` and `README.md`).
- If `npm run build` fails on permissions:
  - The build runs `shx chmod +x dist/*.js`; ensure `shx` is installed (it’s a devDependency) and rerun `npm install`.

## Open Questions / TODO

- `server.json` is referenced by `scripts/release.*` and `.github/workflows/release.yml`, but it is not present in this repo checkout. Confirm whether it should be committed (or generated) as part of the release flow.
- `README.md` lists some dependencies/versions (e.g., Cheerio, undici, Zod) that don’t match `package.json` in this checkout. Consider updating the README tech stack table to reflect `package.json`.
