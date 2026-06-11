---
description: "Audit repository documentation and Claude customization files so they match the current codebase and workflow."
argument-hint: "[scope or recent change summary]"
---

Audit the repository documentation and bring it back in sync with the current codebase.

Scope hint (optional): $ARGUMENTS

Requirements:
- Focus on accuracy, not churn.
- If a scope or recent change summary is provided, narrow the audit to the affected files and their related documentation. If omitted, audit all listed files.
- Update only docs and customization files that are stale, incomplete, or misleading.
- Verify behavior from source files before editing documentation.
- Keep the `CLAUDE.md` files, `.claude/guides/`, and `.claude/commands/` coherent with the actual repository workflow.

Audit scope:
- `README.md`
- `ARCHITECTURE.md`
- `CLAUDE.md` (root) and the nested `CLAUDE.md` files (`apps/api`, `apps/api/prisma`, `apps/web`, `packages/shared`)
- `.claude/guides/`
- `.claude/commands/`
- Plugin contract docs in `apps/api/src/plugin/types.ts` and `apps/web/src/plugin/types.ts`
- Shared contract guidance implied by `packages/shared`, `apps/api`, and `apps/web`

Recommended steps:
1. Review the active change scope with `git status --short`, `git diff --stat`, and `git diff --cached --stat`.
2. Read the affected source files before editing docs.
3. Update high-level docs when setup, architecture, contracts, or workflow changed.
4. Update the `CLAUDE.md` files and guides when file coverage, conventions, or maintenance guidance drifted.
5. Update command files when the expected workflow changed.
6. If new code lands in an area a guide describes, make sure the guide's "applies to" path list and the root `CLAUDE.md` domain-guide index still point at it.
7. Summarize what changed, what stayed correct, and any remaining documentation gaps.

Notes:
- Each guide under `.claude/guides/` is a condensed mirror of a `docs/*.md` source of truth; keep both aligned when a contract changes.
- Do not rewrite accurate sections just for style consistency.
- When the code and docs disagree, verify the code before choosing the final wording.
- If a listed file does not exist, skip it and note its absence in the summary. If it should exist based on the codebase, recommend creating it.
