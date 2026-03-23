# AGENTS.md

Intelligent web content fetcher MCP server that converts HTML to clean, AI-readable Markdown.

## Tooling

- **Manager**: npm
- **Frameworks**: typescript, eslint, @modelcontextprotocol/sdk, @modelcontextprotocol/sdk, @trivago/prettier-plugin-sort-imports, eslint, eslint-config-prettier, eslint-plugin-de-morgan

## Architecture

- Tool-based MCP server with two entry paths:
  `src/index.ts` selects stdio by default and HTTP mode via CLI flags, and installs shared fatal-error and graceful-shutdown handling.
- `src/server.ts` builds the core `McpServer`, registers tools/prompts/resources, enables task-capable tool execution, and shuts down the transform worker pool on exit.
- `src/tools/fetch-url.ts` is the main product surface. It validates inputs with Zod, wraps tool calls in request context, reports progress, supports optional MCP task execution, and emits structured JSON-safe output.
- `src/lib/fetch-pipeline.ts` holds the shared fetch/cache/transform pipeline:
  URL normalization and raw-URL rewriting happen before fetch, cache lookup/persist is centralized, redirects can populate alias cache keys, and inline Markdown truncation is applied after transform.
- `src/transform/*` contains HTML-to-Markdown conversion and worker-pool logic; expensive transforms are intentionally isolated from transport code.
- `src/http/native.ts` is a separate authenticated Streamable HTTP gateway:
  it manages MCP sessions, protocol-version negotiation, rate limiting, CORS/host checks, health/download routes, and cancels owner-scoped tasks when sessions expire, are evicted, or shut down.

## Testing Strategy

- Tests live in `tests/` and primarily exercise built output from `dist/`, so changes usually need a fresh `npm run build` before targeted test runs.
- Coverage is subsystem-oriented rather than purely unit-level:
  CLI/bootstrap (`cli.test.ts`, `mcp-server.test.ts`), fetch/cache pipeline (`fetch-pipeline.test.ts`, cache tests, redirects), HTTP server/auth/session behavior (`http-*`, `health-endpoint.test.ts`, download routes), and task lifecycle/cancellation (`task-manager.test.ts`, `mcp-task-tools.test.ts`).
- The suite also covers transform correctness and output cleanup:
  Markdown cleanup, DOM noise removal, code language tagging, header promotion, truncation behavior, and worker/telemetry behavior under `transform-*` tests.
- Several tests spawn isolated Node processes or use mocked fetch servers/fixtures to verify runtime behavior, startup constraints, and shutdown semantics instead of only asserting pure functions.
- When changing protocol wiring, HTTP lifecycle, or task ownership, prefer running the focused matching test files first, then `npm run test` before finishing.

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Build**: `npm run build`
- **Format**: `npm run format`
- **Type Check**: `npm run type-check`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run test:coverage`, `npm run prepublishOnly`, `git push origin master --follow-tags`, `gh release create "v$VERSION" --title "v$VERSION" --generate-notes`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: Never read or exfiltrate secrets or credentials.; Never edit generated files like `.git` manually.; commit or expose secrets/credentials; edit vendor/generated directories; change production config without approval

## Directory Overview

```text
.
├── .github/            # CI/workflows and repo automation
├── .vscode/
├── assets/             # static assets
├── memory_db/
├── scripts/            # automation scripts
├── src/                # application source
├── tests/              # test suites
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
├── AGENTS.md           # agent guidance
├── docker-compose.yml  # local container orchestration
├── Dockerfile          # container image build
├── eslint.config.mjs   # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
└── server.json         # published server metadata
└── ...                # 3 more top-level items omitted
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`, `docker-compose.yml`
- **Key Configs**: `.prettierrc`, `tsconfig.json`

## Don'ts

- Don't bypass existing lint/type rules without approval.
- Don't ignore test failures in CI.
- Don't use unapproved third-party packages without checking package manager manifests.
- Don't hardcode secrets or sensitive info in code, tests, docs, or config.
- Don't edit generated files directly.
- Don't trigger releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
