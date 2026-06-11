---
description: "Stage, review, and commit the current changes with a mandatory documentation review."
argument-hint: "[message hint or summary] [push]"
---

Commit the current changes to git.

Invocation input (optional): $ARGUMENTS

Requirements:
- Review both staged and unstaged changes before deciding on the final commit scope.
- If there are no staged or unstaged changes, inform the user and exit without committing.
- Stage only changes that belong in the commit. Do not stage files that should be ignored, including `dist/`, `build/`, `.next/`, `coverage/`, `node_modules/`, `.env*`, `*.secret`, or other generated files unrelated to the current change; if such files appear in the diff, add or update `.gitignore` instead of staging them.
- Perform a mandatory documentation review before committing.
- Draft the commit message before running `git commit`.
- Do not ask for confirmation before committing unless the invocation explicitly requests a confirmation step.
- Treat an explicit `push` request in the invocation as approval to run `git push` after a successful commit. Otherwise ask before pushing.

Documentation review scope:
- `README.md` for setup, workflow, or user-visible behavior changes.
- `ARCHITECTURE.md` for structural or data-flow changes (especially anything that touches the plugin contracts).
- `CLAUDE.md` files and `.claude/guides/` for area-specific guidance that may now be stale or too narrow.
- `.claude/commands/` when command behavior or workflow expectations changed.
- Shared contract guidance whenever `packages/shared` or API/web boundaries changed.

Recommended steps:
1. `git diff --stat` and `git diff --cached --stat`.
2. Inspect changed files and stage only the intended commit scope with selective `git add <path>` commands, or use `git add -A` followed immediately by `git reset <excluded-path>` for anything that must stay unstaged.
3. Review the documentation scope above and update what is stale.
4. Explicitly confirm when no documentation updates are needed.
5. Draft a commit message in imperative mood with a short subject line; add a short body if the change is non-trivial.
6. Run `git commit`.
7. If the invocation asked for `push`, run `git push`.

Notes:
- If `npm run validate` is configured as a hook and fails, fix and retry.
- If `git commit` fails due to merge conflicts, lock files, or another dirty-state problem, report the error and suggest resolution steps rather than retrying blindly.
- Treat phrases like `confirm first`, `review before commit`, or `show me the message first` as explicit pause requests.
