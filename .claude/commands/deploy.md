---
description: "Review, document, commit, push, and deploy the current changes with the production SSH workflow unless the invocation requests a pause."
argument-hint: "[change summary | confirm first | dry run | alternate deploy args]"
---

Commit, push, and deploy the current changes.

Invocation input (optional): $ARGUMENTS

Requirements:
- Review both staged and unstaged changes before deciding on the final commit scope.
- Stage all relevant tracked changes by default with `git add -A`, then unstage any build output, secrets, or unrelated generated files with `git reset HEAD <path>` unless they are intentionally tracked.
- Perform a mandatory documentation review before committing.
- Draft the commit message before running `git commit`.
- Do not ask for confirmation before committing unless the invocation explicitly requests a confirmation step, review-only pause, dry run only, or message approval.
- Treat the invocation as approval to run `git push` after a successful commit unless it explicitly says not to push.
- Treat the invocation as approval to deploy after a successful push unless it explicitly says not to deploy.
- Use the production SSH deploy path by default: `npm run deploy:prod:ssh`.
- If the invocation explicitly requests `push`, include the push step even when the deploy command could also push.
- If the invocation explicitly requests deploy args such as `--dry-run`, `--host`, `--port`, `--repo-path`, `--branch`, or `--skip-validate`, pass them through to the deploy command.

Documentation review scope:
- `README.md` for setup, workflow, deployment, or user-visible behavior changes
- `ARCHITECTURE.md` for structural, runtime, or data-flow changes
- `CLAUDE.md` files and `.claude/guides/` for area-specific guidance that may now be stale or too narrow
- `.claude/commands/` when command behavior or workflow expectations changed
- Shared contract guidance whenever `packages/shared` or API/web boundaries changed

Recommended steps:
1. Run `git diff --stat` and `git diff --cached --stat`.
2. Inspect the changed files, stage the intended commit set with `git add -A`, then unstage any build output, secrets, or unrelated generated files such as `dist/`, `build/`, `.env`, or force-added ignored files.
3. Review the documentation scope above and update any affected files.
4. Explicitly confirm when no documentation updates are needed.
5. Draft a commit message in imperative mood with a short subject line.
6. If the change is non-trivial, add a short body that explains why.
7. If the invocation explicitly requests a pause or review, show the proposed message and stop before `git commit`.
8. Otherwise, show the message you are using and run `git commit` without waiting. If `git commit` fails, report the full error and stop.
9. Run `git push` after the commit succeeds unless the invocation explicitly disables pushing. If `git push` fails, report the full error and suggest `git pull --rebase` before retrying.
10. Run the production deploy command after the push succeeds unless the invocation explicitly disables deployment. If the deploy command fails, display the full error output, do not retry automatically, and suggest checking SSH connectivity and that local `HEAD` matches `origin/<branch>`.
11. Summarize the exact push and deploy commands that were used, along with any remote validation signals or errors.

Notes:
- Persistent data lives in the `printstream-data` Docker volume. Never destroy it without explicit user confirmation.
- The SSH deploy script refuses to push with a dirty local tree and refuses to deploy if local `HEAD` does not match `origin/<branch>`.
- The remote deploy step refuses to continue if the server checkout has tracked changes.
- Treat phrases such as `confirm first`, `ask before committing`, `show me the message first`, `review before commit`, or `dry run only` as explicit requests to pause before the mutating step they reference.
