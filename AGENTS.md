# AGENTS.md

TypeScript MCP server for fetching public web pages and converting them to clean Markdown, with Docker and GitHub Actions support.

## Tooling

- **Manager**: npm
- **Frameworks**: TypeScript, `@modelcontextprotocol/sdk`, Zod, ESLint, Prettier

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Deploy**: N/A

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`, `npm run format`
- **Ask First**: `npm run build`, `npm run test:coverage`, `npm run dev:run`, dependency installs, deleting files, Docker publish/release workflow changes
- **Never**: commit or expose credentials (`.env*`, tokens), edit generated/vendor/dependency folders (`dist/`, `node_modules/`, `.git/`), change production/release config without approval

## Directory Overview

```text
.
├── src/                 # MCP server source code
├── tests/               # automated test suite
├── docs/                # documentation
├── scripts/             # build/test task runners
├── examples/            # client usage examples
├── assets/              # static assets
├── .github/
│   └── workflows/       # CI/release automation
├── package.json         # scripts and dependencies
├── server.json          # MCP server metadata
├── README.md            # primary project guide
├── Dockerfile           # container build
└── docker-compose.yml   # local container orchestration
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`, `docker-compose.yml`
- **Key Configs**: ESLint (`eslint.config.mjs`), Prettier (`.prettierrc`), TypeScript (`tsconfig*.json`), Git (`.gitignore`)

## Don'ts

- Don't edit generated outputs in `dist/`.
- Don't modify dependencies under `node_modules/`.
- Don't commit credentials, API keys, or `.env` files.
- Don't run release/publish workflow changes without approval.
- Don't change `Dockerfile` or GitHub release workflows for production behavior without approval.

## Change Checklist

1. Run `npm run lint`.
2. Run `npm run type-check`.
3. Run `npm run test`.
4. Confirm no secrets or `.env` files are included in changes.
5. Update `README.md` when behavior or commands change.
