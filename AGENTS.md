# Repository Guidelines

## Project Structure & Module Organization

- `src/` holds TypeScript source. Core areas: `config/`, `services/`, `tools/`, `transformers/`, `middleware/`, `utils/`, `resources/`. Entrypoints: `src/index.ts` and `src/server.ts`.
- `tests/` contains Vitest suites named `*.test.ts`.
- `scripts/` provides release and benchmarking utilities.
- `dist/` is the compiled output (generated).
- `docs/` stores documentation and assets.

## Build, Test, and Development Commands

- `npm install` installs dependencies (Node >= 20.12 required).
- `npm run dev` starts the dev server with hot reload (tsx watch).
- `npm run build` compiles TypeScript to `dist/`.
- `npm start` runs the production server from `dist/`.
- `npm run lint` / `npm run lint:fix` runs ESLint checks and fixes.
- `npm run type-check` runs `tsc --noEmit`.
- `npm run format` formats with Prettier.
- `npm test` / `npm run test:coverage` runs Vitest (with coverage).
- `npm run bench` builds and runs the benchmark.
- `npm run knip` / `npm run knip:fix` checks for unused exports and deps.

## Coding Style & Naming Conventions

- Prettier enforces 2-space indentation, single quotes, semicolons, LF line endings, and 80-char print width.
- Imports are sorted and grouped via `@trivago/prettier-plugin-sort-imports`; keep local groups (config/services/middleware/utils/transformers/tools/resources) consistent.
- ESLint (TypeScript strict) enforces `camelCase` for variables/functions, `PascalCase` for types/classes, `UPPER_CASE` for constants/enums. Leading `_` is allowed for intentionally unused params. Prefer type-only imports.

## Testing Guidelines

- Tests live in `tests/` with `*.test.ts` naming.
- Use Vitest via `npm test`; add coverage with `npm run test:coverage`.
- Add or update tests when changing tools, transformers, services, or HTTP routes.

## Commit & Pull Request Guidelines

- Commit history follows Conventional Commits (examples: `feat: ...`, `refactor: ...`, `chore: release vX.Y.Z`). Use the release script for version bumps.
- Create branches like `feature/short-description`.
- PRs should include a concise summary, testing notes (`npm run lint`, `npm test`), and any documentation updates.

## Security & Configuration Tips

- This server fetches external URLs; avoid relaxing SSRF or CORS protections in production.
- Configure behavior via environment variables (for example: `CACHE_TTL`, `FETCH_TIMEOUT`, `LOG_LEVEL`, `ALLOWED_ORIGINS`) and document new keys in `README.md`.
