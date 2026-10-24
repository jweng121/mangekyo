# Mangekyo: Visual Intelligence for Autonomous Trust Finance

# Overview


# User Workflow


# Why Mangekyo?

## Workspace

- `apps/web`: reserved for the final integrated platform.
- `apps/finance-dev`: finance persistence and live event/snapshot development UI (port 3001).
- `packages/visual-audit/src`: visual audit components, agents, hooks, and capture code.
- `packages/visual-audit/playground`: local Next.js UI for visual audit development.
- `packages/finance-core`: Edwin's finance package.
- `packages/contracts`: shared types package.

## Local development

Use Node.js 22.12 or newer and pnpm. From the repository root:

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000 to view the playground. Run `pnpm typecheck` to check
types and `pnpm build` to build the playground. On Windows, use `pnpm.cmd` if
PowerShell blocks the `pnpm.ps1` launcher.

The components are placeholders; agent, capture, and audit behavior can be
implemented inside `packages/visual-audit`. Empty directories use `.gitkeep`
files so the workspace structure is preserved in Git.

For the finance app, existing Convex development deployment setup, and shared
audit query contracts, see [Finance persistence](docs/finance-persistence.md).
Run `pnpm dev:backend` and `pnpm dev:finance` in separate root terminals after setup.

The next milestone's [finance investigator integration](docs/finance-investigation.md)
documents mock mode, CREAO agent instructions and server credentials, task-scoped
clarifications, and the live audit interfaces.
