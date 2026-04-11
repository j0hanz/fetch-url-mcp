# AGENTS.md

An MCP server that fetches web pages and converts them to clean, readable Markdown.

## Tooling

- **Manager**: npm
- **Language**: TypeScript (ESM, Node >=24)
- **Linting**: ESLint (sonarjs, unicorn, unused-imports, de-morgan, depend)
- **Formatting**: Prettier (@trivago/prettier-plugin-sort-imports)

## Architecture

- Tool-based MCP server (MCP SDK v2 alpha)
- HTTP fetch → HTML parse (linkedom + @mozilla/readability) → Markdown conversion (node-html-markdown)
- Task system for async tool execution

## Testing Strategy

- 30 test files in `__tests__/` (colocated), run via Node.js built-in test runner
- `npm run test` for all tests; `npm run test:coverage` for coverage

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Deploy**: `npm run prepublishOnly`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run test:coverage`, `npm run prepublishOnly`, `git push origin master --follow-tags`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: commit or expose secrets/credentials; edit vendor/generated directories (`dist/`, `.git/`, `node_modules/`); change production config without approval

## Directory Overview

```text
.
├── __tests__/          # test suites
├── .agents/            # agent skills and config
├── .github/            # CI/workflows (release, docker-republish)
├── assets/             # static assets
├── memory_db/          # persistent memory store
├── scripts/            # automation scripts
├── src/                # application source
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
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
- Don't commit secrets/credentials to the repo.
- Don't edit generated files directly.
- Don't trigger releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
