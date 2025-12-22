# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript source. Key areas include `src/tools/` (MCP tools/handlers), `src/services/` (fetching, parsing, caching, logging), `src/utils/` (sanitization and helpers), `src/transformers/` (markdown/JSONL output), and `src/resources/` (MCP resources).
- `dist/` is the compiled output from `npm run build` and should not be edited manually.
- `scripts/` holds release automation (`scripts/release.js`, `.sh`, `.bat`).
- `docs/` contains static assets (for example `docs/logo.png`).
- Root config files include `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, and `server.json`.

## Build, Test, and Development Commands

- `npm run dev`: run the server in watch mode with `tsx`.
- `npm run build`: compile TypeScript and fix executable flags in `dist/`.
- `npm start`: run the compiled server from `dist/index.js`.
- `npm run lint` / `npm run lint:fix`: check or auto-fix ESLint issues.
- `npm run type-check`: run `tsc --noEmit` for type safety.
- `npm run format`: apply Prettier formatting and import sorting.
- `npm run knip` / `npm run knip:fix`: detect and optionally remove unused code.

## Coding Style & Naming Conventions

- Formatting is enforced by Prettier (2-space indentation, single quotes, semicolons, 80-char print width).
- ESLint is required before release; keep rule violations to zero.
- File names use kebab-case (for example `fetch-url.tool.ts`, `content-cleaner.ts`).
- Prefer PascalCase for types/interfaces and camelCase for values/exports.

## Testing Guidelines

- No dedicated test runner or `test` script is defined in `package.json`.
- Use `npm run lint` and `npm run type-check` as the baseline verification steps.
- If you add tests, include a script (for example `npm test`) and document the location and runner in this file and `README.md`.

## Commit & Pull Request Guidelines

- Commit history uses Conventional Commit-style subjects (for example `refactor: ...`) with occasional version-only commits like `1.1.1`.
- Keep commit subjects short and imperative; scope optional.
- PRs should include: a concise summary, rationale, testing commands run, and any config/env changes. Update `README.md` for user-facing behavior changes.

## Security & Configuration Tips

- This server fetches external URLs; preserve SSRF protections and header sanitization.
- Prefer configuration via environment variables (for example `FETCH_TIMEOUT`, `CACHE_TTL`, `LOG_LEVEL`) rather than hardcoding.
- Avoid committing secrets or tokens; use local env files or CI secrets.
