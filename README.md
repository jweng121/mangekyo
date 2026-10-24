# Mangekyo: Visual Intelligence for Autonomous Trust Finance

# Overview


# User Workflow


# Why Mangekyo?

## Workspace

- `apps/web`: reserved for the final integrated platform.
- `packages/visual-audit/src`: visual audit components, agents, hooks, and capture code.
- `packages/visual-audit/playground`: local Next.js UI for visual audit development.
- `packages/finance-core`: Edwin's finance package.
- `packages/contracts`: shared types package.

## Local development

Use Node.js 22 or newer and pnpm. From the repository root:

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
