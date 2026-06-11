---
name: "install-ha"
description: "Install or update the bundled Home Assistant custom integration over SSH using environment-configured targets."
argument-hint: "Optional flags such as --dry-run, --service, or alternate remote paths"
agent: "agent"
model: "GPT-5 (copilot)"
---

Install or update the bundled Home Assistant custom integration.

Requirements:
- Review the current change scope under `integrations/home-assistant/`, `scripts/deploy/`, `README.md`, and `.github/prompts/` before installing.
- Do not require a git commit; this workflow syncs the current local integration files directly to Home Assistant.
- Run a narrow validation for touched Home Assistant files when possible, such as `python3 -m py_compile` for edited Python modules or `node scripts/deploy/install-home-assistant-over-ssh.mjs --help` when the deploy helper changed.
- Use `npm run deploy:ha:ssh` by default.
- Ensure the remote target env vars are set before installing unless the prompt invocation explicitly provides overrides: `HA_DEPLOY_SSH_HOST`, `HA_DEPLOY_CONFIG_PATH`, and `HA_DEPLOY_STACK_PATH`.
- Pass through explicit args such as `--dry-run`, `--host`, `--port`, `--config-path`, `--stack-path`, `--service`, `--compose-file`, and `--ssh-key`.
- `HA_DEPLOY_SERVICE`, `HA_DEPLOY_SOURCE_DIR`, `HA_DEPLOY_COMPOSE_FILES`, `HA_DEPLOY_SSH_PORT`, and `HA_DEPLOY_SSH_KEY` are optional environment overrides.
- Summarize the exact install command used, the remote sync target, and any restart logs or errors.

Recommended steps:
1. Review `git status --short` and `git diff --stat` when local changes are involved.
2. Inspect any changed files under `integrations/home-assistant/custom_components/printstream`.
3. Run a narrow validation for the touched files.
4. Run `npm run deploy:ha:ssh -- <args>`.
5. Report the remote target path and restart result.

Notes:
- This workflow syncs `integrations/home-assistant/custom_components/printstream` into `custom_components/printstream` under the configured Home Assistant config path, then restarts the configured Home Assistant compose service.
- Do not delete unrelated Home Assistant config content on the server.