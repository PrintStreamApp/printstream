---
name: "audit-docs"
description: "Audit repository documentation and Copilot customization files so they match the current codebase and workflow."
argument-hint: "Optional scope or recent change summary"
agent: "agent"
model: "GPT-5 (copilot)"
---

Audit the repository documentation and bring it back in sync with the current codebase.

Requirements:
- Focus on accuracy, not churn.
- If a scope or recent change summary is provided, narrow the audit to the affected files and their related documentation. If omitted, audit all listed files.
- Update only docs and customization files that are stale, incomplete, or misleading.
- Verify behavior from source files before editing documentation.
- Keep `.github/instructions/` and `.github/prompts/` coherent with the actual repository workflow.

Audit scope:
- `README.md`
- `ARCHITECTURE.md`
- `.github/copilot-instructions.md`
- `.github/instructions/`
- `.github/prompts/`
- Plugin contract docs in `apps/api/src/plugin/types.ts` and `apps/web/src/plugin/types.ts`
- Shared contract guidance implied by `packages/shared`, `apps/api`, and `apps/web`

Recommended steps:
1. Review the active change scope with `git status --short`, `git diff --stat`, and `git diff --cached --stat`.
2. Read the affected source files before editing docs.
3. Update high-level docs when setup, architecture, contracts, or workflow changed.
4. Update instruction files when file coverage, conventions, or maintenance guidance drifted.
5. Update prompt files when the expected workflow changed.
6. If new files fall outside an instruction file's `applyTo` coverage, widen the glob.
7. Summarize what changed, what stayed correct, and any remaining documentation gaps.

Notes:
- Do not rewrite accurate sections just for style consistency.
- When the code and docs disagree, verify the code before choosing the final wording.
- If a listed file does not exist, skip it and note its absence in the summary. If it should exist based on the codebase, recommend creating it.
