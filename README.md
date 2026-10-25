# Mangekyo: Visual Intelligence for Autonomous Trust Finance

# Overview


# User Workflow


# Why Mangekyo?

## Workspace

- `apps/web`: reserved for the final integrated platform.
- `apps/visual-audit-dev`: Phase 2 Next.js investigation UI, synthetic ERP, browser agent, and server routes.
- `packages/visual-audit`: shared graph, evidence, narration, and Phase 1 components.
- `packages/visual-audit/playground`: earlier development playground (`pnpm dev:playground`).
- `packages/finance-core`: Edwin's finance package.
- `packages/contracts`: shared types package.

## Local development

Use Node.js 22 or newer and pnpm. From the repository root:

```sh
pnpm install
pnpm --filter @mangekyo/visual-audit-dev exec playwright install chromium
pnpm dev
```

Open http://localhost:3000 to view the Phase 2 investigation; `/erp` is the synthetic source, and `/?mode=synthetic` preserves the Phase 1 demo. See [Visual audit setup](docs/VISUAL_AUDIT.md) for escalation, steering, providers, storage, and limitations. Run `pnpm typecheck` to check
types and `pnpm build` to build the app. On Windows, use `pnpm.cmd` if
PowerShell blocks the `pnpm.ps1` launcher.

The local browser agent records actual Chromium screenshots of synthetic ERP data. Its financial action is a draft proposal only.
