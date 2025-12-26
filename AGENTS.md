# Repository Guidelines

## Project Structure & Module Organization

- `src/` holds the TypeScript source. Key areas: `src/tools/` (MCP tools/handlers), `src/services/` (fetching, parsing, caching, logging), `src/utils/` (sanitization/helpers), `src/transformers/` (markdown/JSONL output), and `src/resources/` (MCP resources).
- `tests/` contains Vitest tests.
- `dist/` is the compiled output from `npm run build` and should not be edited.
- `scripts/` contains release automation (for example `scripts/release.js`, `.sh`, `.bat`).
- `docs/` stores static assets (for example `docs/logo.png`).
- Root config files include `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, and `server.json`.

## Build, Test, and Development Commands

- `npm run dev`: run the server in watch mode with `tsx`.
- `npm run build`: compile TypeScript and fix executable flags in `dist/`.
- `npm start`: run the compiled server from `dist/index.js`.
- `npm run lint` / `npm run lint:fix`: check or auto-fix ESLint issues.
- `npm run type-check`: run `tsc --noEmit` for type safety.
- `npm run format`: apply Prettier formatting and import sorting.
- `npm test` / `npm run test:coverage`: run Vitest tests (with coverage).
- `npm run bench`: run the minimal performance benchmark (builds first).

## Coding Style & Naming Conventions

- Formatting: Prettier with 2-space indentation, single quotes, semicolons, 80-char print width.
- Linting: ESLint must pass before release.
- File names use kebab-case (for example `fetch-url.tool.ts`).
- Prefer PascalCase for types/interfaces and camelCase for values/exports.

## Testing Guidelines

- Test runner: Vitest; tests live under `tests/`.
- Keep tests fast and deterministic; avoid network access.
- Run `npm test` locally and `npm run test:coverage` for coverage checks.

## Commit & Pull Request Guidelines

- Commit subjects use Conventional Commits (for example `refactor: tighten SSRF checks`), with occasional version-only commits like `1.1.1`.
- PRs should include a concise summary, rationale, testing commands run, and any config/env changes.
- Update `README.md` for user-facing behavior changes.

## Security & Configuration Tips

- Preserve SSRF protections and header sanitization in fetch logic.
- Prefer configuration via environment variables (for example `FETCH_TIMEOUT`, `CACHE_TTL`, `LOG_LEVEL`).
- Avoid committing secrets or tokens; use local env files or CI secrets instead.
