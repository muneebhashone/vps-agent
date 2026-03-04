# VPS Deployment Guide (Step-by-Step)

This guide covers full production deployment of this agent on a Linux VPS and Slack Socket Mode connection.

## 1. Prerequisites

- Linux VPS with root/sudo access
- Domain name with DNS control
- Slack workspace where you can create/install apps
- OpenRouter API key
- GitHub token (for private repositories)

## 2. Prepare DNS

If `baseDomain` is `example.com`, create:

- `A` record: `example.com` -> `<your-vps-ip>`
- Wildcard `A` record: `*.example.com` -> `<your-vps-ip>`

This is required for auto routes like `my-repo.example.com`.

## 3. Install VPS dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl unzip jq ca-certificates
```

Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

Install Docker + Compose plugin (if missing):

```bash
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
docker --version
docker compose version
```

Install Caddy:

```bash
sudo apt install -y caddy
sudo systemctl enable --now caddy
caddy version
```

## 4. Ensure Caddy imports managed snippets

Open `/etc/caddy/Caddyfile` and make sure it includes:

```caddy
import /etc/caddy/conf.d/*.caddy
```

Create the include directory if needed:

```bash
sudo mkdir -p /etc/caddy/conf.d
sudo systemctl reload caddy
```

## 5. Clone and install the agent

```bash
sudo mkdir -p /opt/vps-agent
sudo chown -R $USER:$USER /opt/vps-agent
git clone <your-repo-url> /opt/vps-agent
cd /opt/vps-agent
bun install
```

## 6. Run setup wizard

```bash
bun run src/index.ts setup
```

This creates:

- `config/agent.yaml`
- `config/policy.yaml`
- `config/secrets.env`

## 7. Configure agent settings

Edit `config/agent.yaml` and set at least:

- `projects.baseDomain`
- `projects.discoveryRoots`
- `paths.deployRoot`
- OpenCode model IDs (`opencode.modelPrimary`, `opencode.modelFallback`)

Example:

```yaml
projects:
  discoveryRoots:
    - /srv
    - /opt
    - /var/www
  baseDomain: yourdomain.com
```

## 8. Configure secrets

Edit `config/secrets.env`:

```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
OPENROUTER_API_KEY=sk-or-...
GITHUB_TOKEN=ghp_...
```

Lock permissions:

```bash
chmod 600 config/secrets.env
```

## 9. Create and connect the Slack app

1. Go to `https://api.slack.com/apps` and create a new app.
2. Enable **Socket Mode** and generate an **App-Level Token** with scope:
   - `connections:write`
3. In **OAuth & Permissions**, add bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `commands`
4. Install/reinstall the app to your workspace.
5. In **Event Subscriptions**, subscribe to bot event:
   - `app_mention`
6. Add slash commands:
   - `/agent-discover`
   - `/agent-status`
   - `/agent-shell`
   - `/agent-approve`
   - `/agent-deny`
   - `/agent-deploy`
   - `/agent-skill`
7. Copy tokens into `config/secrets.env`:
   - App-Level Token -> `SLACK_APP_TOKEN`
   - Bot User OAuth Token -> `SLACK_BOT_TOKEN`

Note: Slack UI may still ask for a Request URL while creating slash commands; Socket Mode traffic is delivered over websocket once the app is running.

## 10. Create systemd service

Create `/etc/systemd/system/vps-agent.service`:

```ini
[Unit]
Description=VPS Agent (Slack + OpenCode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vps-agent
EnvironmentFile=/opt/vps-agent/config/secrets.env
ExecStart=/root/.bun/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If Bun binary is elsewhere, replace `ExecStart` accordingly (`which bun`).

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-agent
sudo systemctl status vps-agent --no-pager
```

## 11. Validate deployment

Check logs:

```bash
sudo journalctl -u vps-agent -f
```

Expected:

- service starts with no missing env errors
- Slack socket mode connects successfully
- project discovery runs

From Slack:

- Run `/agent-status`
- Run `/agent-discover`
- Mention the bot: `@agent status`

## 12. First project deployment flow

From Slack:

```text
/agent-deploy https://github.com/you/your-repo.git main
```

Agent will:

1. Clone/pull repo
2. Detect stack
3. Build/run Docker or Compose
4. Health check
5. Write Caddy managed routes
6. Reload Caddy

Then visit:

`https://<repo-name>.<baseDomain>`

## 13. High-risk command approval flow

If a command is high risk, it returns request ID:

```text
Approval required ... Request ID: apr-xxxx
```

Approve:

```text
/agent-approve apr-xxxx
```

## 14. Deny command management

List rules:

```text
/agent-deny list
```

Add regex rule:

```text
/agent-deny add regex (^|\s)shutdown\s+-h\s+now
```

Remove rule:

```text
/agent-deny remove <rule-id>
```

## 15. Skills usage

Put skill folders under `skills/`:

```text
skills/my-skill/SKILL.md
skills/my-skill/scripts/run.sh
```

Use in Slack:

```text
/agent-skill list
/agent-skill run my-skill
```

## 16. Upgrade procedure

```bash
cd /opt/vps-agent
git pull --ff-only
bun install
sudo systemctl restart vps-agent
sudo journalctl -u vps-agent -n 100 --no-pager
```

## 17. Troubleshooting checklist

- Missing token errors: verify `config/secrets.env` keys and service `EnvironmentFile`
- Slash commands not responding: check app scopes + reinstall app
- Mention events missing: verify `app_mention` subscription
- Domain not routing: verify DNS wildcard and Caddy `import /etc/caddy/conf.d/*.caddy`
- Deploy fails healthcheck: check container logs and `projects.defaultHealthPath`
