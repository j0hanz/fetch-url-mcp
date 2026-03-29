# AGENTS.md

An MCP server that fetches web pages and converts them to clean, readable Markdown.

## Tooling

- **Manager**: npm
- **Frameworks**: TypeScript, ESLint, @modelcontextprotocol/sdk, Prettier, tsx, zod, undici
- **Infrastructure**: Docker, Docker Compose, GitHub Actions

## Architecture

- Tool-based

## Testing Strategy

- Colocated test directories (**tests**/), 30 test files found

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type Check**: `npm run type-check`
- **Format**: `npm run format`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`, `npm run build`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run test:coverage`, `npm run prepublishOnly`, `git push origin master --follow-tags`, `gh release create "v$VERSION" --title "v$VERSION" --generate-notes`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: read or exfiltrate secrets or credentials; edit generated or vendor directories such as `.git`, `dist`, or `node_modules`; change production config without approval

## Directory Overview

```text
├── __tests__/          # test suites
├── .github/            # CI/workflows and repo automation
├── assets/             # static assets
├── scripts/            # automation scripts
├── src/                # application source
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
- Don't edit generated files directly.
- Don't trigger releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
5. Run `npm run build` to verify build success.
6. Update documentation if needed.
