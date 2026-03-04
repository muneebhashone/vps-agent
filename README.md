# VPS Agent (Slack + OpenCode SDK + OpenRouter)

Single-host VPS operations agent that:
- discovers git projects from configured roots
- deploys Docker/Docker Compose projects and maps domains via Caddy
- executes shell commands with denylist + high-risk approval flow
- answers project/VPS questions through Slack mentions
- supports pluggable `SKILL.md + scripts` skills

## Runtime
- Bun + TypeScript
- Slack Socket Mode (`@slack/bolt`)
- OpenCode SDK (`@opencode-ai/sdk`) with OpenRouter provider
- SQLite (`bun:sqlite`) for state and audit trail

## Deployment
- Step-by-step VPS + Slack Socket Mode guide: `docs/DEPLOYMENT.md`

## Quick Start
1. Install dependencies:
   ```bash
   bun install
   ```
2. Run setup wizard:
   ```bash
   bun run src/index.ts setup
   ```
3. Fill `config/secrets.env` with:
   - `SLACK_APP_TOKEN`
   - `SLACK_BOT_TOKEN`
   - `OPENROUTER_API_KEY`
   - `GITHUB_TOKEN` (for private clone/pull)
4. Configure Slack slash commands in your Slack app:
   - `/agent-discover`
   - `/agent-status`
   - `/agent-shell`
   - `/agent-approve`
   - `/agent-deny`
   - `/agent-deploy`
   - `/agent-skill`
5. Start:
   ```bash
   bun run start
   ```

## Config Files
- `config/agent.yaml`: runtime configuration
- `config/policy.yaml`: denylist + risk patterns
- `config/secrets.env`: sensitive credentials (not committed)

## Safety Model
- Every shell command is policy-evaluated.
- Denied commands are blocked immediately.
- High-risk commands create approval requests and require `/agent-approve <id>`.
- Command/deploy activity is persisted in SQLite (`data/agent.db`).

## Mention Commands
- `@agent discover`
- `@agent deploy <repo-url-or-path> [branch]`
- `@agent shell <command>`
- `@agent status`
- Any other mention is treated as a Q&A/debug request.

## Current Deploy Coverage
- Fully automated:
  - Docker Compose projects
  - Dockerfile projects
- For non-containerized stacks (Node/Python/Go/Rust/Java), the agent currently detects and tracks the project, then asks for explicit run/build guidance (or a skill).
