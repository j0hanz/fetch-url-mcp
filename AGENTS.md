# AGENTS.md

Fetch public web pages and convert them into clean, AI-readable Markdown.

## Tooling

- **Manager**: npm
- **Frameworks**: typescript, eslint, @modelcontextprotocol/sdk, @trivago/prettier-plugin-sort-imports, eslint-config-prettier, eslint-plugin-de-morgan, eslint-plugin-depend, eslint-plugin-unused-imports

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run prepublishOnly`, `git push origin master --follow-tags`, `gh release create "v$VERSION" --title "v$VERSION" --generate-notes`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: commit or expose secrets/credentials; edit generated/vendor directories (`.git`, `.tmp`, `dist`, `node_modules`); change production config without approval

## Directory Overview

```text
.
├── .github/            # CI/workflows and repo automation
├── .vscode/
├── assets/             # static assets
├── docs/               # documentation
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
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`, `docker-compose.yml`
- **Key Configs**: `.prettierrc`, `tsconfig.json`

## Don'ts

- Don't bypass existing lint/type rules without approval.
- Don't ignore test failures in CI.
- Don't use unapproved third-party packages without checking package manager manifests.
- Don't hardcode secrets or sensitive info in code, tests, docs, or config.
- Don't edit generated/vendor directories such as `.git`, `.tmp`, `dist`, or `node_modules`.
- Don't trigger releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
