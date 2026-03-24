# AGENTS.md

A web content fetcher MCP server that converts HTML to clean, AI and human readable markdown.

## Tooling

- **Manager**: npm
- **Runtime**: Node.js `>=24`, native ESM package, CLI entrypoint at `dist/index.js`
- **Build**: TypeScript compiles through `scripts/tasks.mjs`, which cleans `dist/`, runs `tsc -p tsconfig.build.json`, copies `assets/`, and marks the CLI executable
- **MCP SDK**: `@modelcontextprotocol/sdk` powers the stdio server, Streamable HTTP transport, prompts, resources, logging, completions, and task-capable tool wiring
- **Fetch + transform stack**: `undici` for HTTP fetches, `linkedom` plus `@mozilla/readability` for DOM parsing/extraction, `node-html-markdown` for Markdown conversion
- **Schemas**: Zod v4 schemas validate tool input/output and cached payloads, and are also converted to JSON Schema for MCP tool registration
- **Lint + format**: flat ESLint config with `typescript-eslint` strict/stylistic rules, `eslint-plugin-depend`, `eslint-plugin-unused-imports`, `eslint-plugin-de-morgan`, plus Prettier with import sorting
- **Tests + diagnostics**: Node's built-in test runner executes TypeScript tests through `tsx/esm`; dedicated scripts exist for coverage, extended type-check diagnostics, and trace generation
- **Repo maintenance**: `knip` is available for unused-code audits, and Docker/Docker Compose files support containerized packaging and local runs

## Architecture

- **Bootstrap**: `src/index.ts` parses CLI flags, serves `--help` / `--version`, and starts either stdio mode or HTTP mode with fatal-error handling and graceful shutdown paths
- **Server composition**: `src/server.ts` creates the MCP server, advertises capabilities, registers the `fetch-url` tool, `get-help` prompt, instruction resource, cache resource template, logging level handler, and shutdown cleanup
- **Transport split**: stdio mode uses one long-lived `McpServer`; HTTP mode creates one `McpServer` per authenticated session and serves it through `StreamableHTTPServerTransport`
- **Fetch pipeline**: `src/tools/fetch-url.ts` validates arguments with Zod, emits progress updates, and delegates execution to `performSharedFetch()` for normalization, cache lookup, remote fetch, transform, and response assembly
- **URL + cache layer**: `src/lib/fetch-pipeline.ts` normalizes URLs, rewrites supported code-host pages to raw endpoints, serializes cached Markdown payloads, and applies inline truncation safeguards for links and code fences
- **Transform isolation**: `src/transform/worker-pool.ts` runs HTML-to-Markdown work in worker threads with queue backpressure, dynamic pool scaling, cancellation, per-task timeouts, and worker restart on failure
- **HTTP gateway**: `src/http/native.ts` wraps MCP over HTTP with host/origin validation, auth, rate limiting, health and download routes, protocol-version negotiation, session TTL cleanup, and shutdown draining
- **Task system**: `src/tasks/manager.ts` keeps owner-scoped task state with TTLs, capacity limits, cancellation, signed pagination cursors, and waiter-based delivery for terminal task results
- **Resource surface**: `src/resources/index.ts` exposes `internal://instructions` and `internal://cache/{namespace}/{hash}`, including completions and resource update notifications backed by the in-memory cache

## Testing Strategy

- Unit tests cover core logic in isolation, such as URL normalization, cache key generation, and transform correctness with various HTML inputs
- Integration tests validate the full fetch pipeline, including cache hits/misses, transform outcomes, and end-to-end behavior.

## Commands

- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type-check**: `npm run type-check`
- **Format**: `npm run format`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run test:coverage`, `npm run prepublishOnly`, `git push origin master --follow-tags`, `gh release create "v$VERSION" --title "v$VERSION" --generate-notes`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: Never read or exfiltrate secrets or credentials.; Never edit generated files like `.git` manually.; commit or expose secrets/credentials; edit vendor/generated directories; change production config without approval

## Directory Overview

```text
├── __tests__           # test suites
├── .github/            # CI/workflows and repo automation
├── .vscode/
├── assets/             # static assets
├── memory_db/
├── scripts/            # automation scripts
├── src/                # application source
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
├── docker-compose.yml  # local container orchestration
├── Dockerfile          # container image build
├── eslint.config.mjs   # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
├── server.json         # published server metadata
└── tsconfig.build.json # TypeScript config
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
5. Update `README.md` if usage or setup instructions change.
