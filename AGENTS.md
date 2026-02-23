# AGENTS.md

This repository is a TypeScript MCP server (`@j0hanz/fetch-url-mcp`) that fetches public web pages and converts them to clean Markdown.

Uses `npm` (Node.js `>=24`).

## Commands

- Install deps: `npm install`
- Build: `npm run build`
- Type-check: `npm run type-check`
- Lint: `npm run lint`
- Lint (fix): `npm run lint:fix`
- Test: `npm run test`
- Coverage (expensive): `npm run test:coverage`
- Format (repo-wide): `npm run format`
- Run server: `npm run start` (or `npm run dev` + `npm run dev:run`)

## Workflows

### Fast Validation Path

1. `npm run type-check`
2. `npm run lint`
3. `npm run test`
4. `npm run build`

Use this sequence after non-trivial code changes.

### Test Modes

- Standard suite (build + tests): `npm run test`
- Fast source tests only: `npm run test:fast`
- Coverage run (expensive): `npm run test:coverage`

### Lint/Format

- Check lint: `npm run lint`
- Auto-fix lint issues: `npm run lint:fix`
- Format repository: `npm run format`

### File-Targeted Recipes

Use file-scoped commands first when possible to reduce cycle time:

- ESLint fix one file: `npx eslint <file> --fix`
- Prettier one file: `npx prettier --write <file>`
- TypeScript diagnostics: `npm run type-check:diagnostics`
- TypeScript trace (slow): `npm run type-check:trace`

### Risky Areas Requiring Extra Care

- `.github/workflows/` (release/automation impact)
- `src/http-native.ts` (HTTP transport/auth/session behavior)
- `src/fetch.ts` (networking, host validation, SSRF controls)
- `src/config.ts` (runtime environment behavior)

## Safety Boundaries

### Always

- Keep changes focused and minimal; follow existing TypeScript + MCP SDK patterns.
- Validate with `npm run type-check` and targeted tests when behavior changes.
- Prefer editing source under `src/` and tests under `tests/`.

### Ask First

- Installing/removing dependencies.
- Deleting files or renaming public-facing symbols.
- Running expensive whole-repo commands (`npm run test:coverage`, repeated full builds).
- Changing release or publishing automation in `.github/workflows/`.
- Changing auth/security defaults or environment variable behavior.

### Never

- Commit or expose secrets/credentials.
- Edit generated/output directories (`dist/`, `node_modules/`) directly.
- Make production-impacting deploy/release changes without explicit approval.
- Bypass eslint or type-checking rules without approval.
- Merge PRs without review and approval from maintainers.

## Navigation

- Entrypoint and transport wiring: `src/index.ts`
- MCP server lifecycle: `src/server.ts`
- Main tool implementation: `src/tools.ts`
- Fetch + SSRF protection: `src/fetch.ts`
- HTTP transport/auth/session logic: `src/http-native.ts`
- Build/test orchestration: `scripts/tasks.mjs`
- Tests: `tests/`

## Canonical Guidance

- TypeScript MCP implementation rules: `.github/instructions/typescript-mcp-server.instructions.md`
- Project architecture and runtime behavior: `README.md`
