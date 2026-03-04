import { App } from "@slack/bolt";
import type { AgentDatabase } from "./db";
import type { DeployManager } from "./deploy";
import type { ProjectDiscoveryService } from "./discovery";
import type { Logger } from "./logger";
import type { OpencodeReasoner } from "./llm";
import type { PolicyEngine } from "./policy";
import type { ShellExecutor } from "./shell";
import type { SkillManager } from "./skills";
import type { AppConfig, CommandResult } from "./types";

function codeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function summarizeCommandResult(result: CommandResult): string {
  if (result.status === "approval_required") {
    return `Approval required for high-risk command.\nRequest ID: \`${result.approvalId}\`\nCommand: \`${result.command}\``;
  }

  if (result.status === "denied") {
    return `Command denied by policy.\nReason: ${result.blockedBy ?? "blocked"}\nCommand: \`${result.command}\``;
  }

  if (result.status === "failed") {
    return `Command failed (exit ${result.exitCode ?? "?"}).\n${
      result.error ?? result.stderr ?? "No error output."
    }`;
  }

  return `Command completed (exit ${result.exitCode ?? 0}).\n${
    result.stdout?.trim() ? codeBlock(result.stdout.trim()) : "_No stdout output_"
  }`;
}

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

export class SlackAgent {
  private readonly app: App;

  constructor(
    config: AppConfig,
    private readonly db: AgentDatabase,
    private readonly shell: ShellExecutor,
    private readonly policy: PolicyEngine,
    private readonly discovery: ProjectDiscoveryService,
    private readonly deploy: DeployManager,
    private readonly skills: SkillManager,
    private readonly reasoner: OpencodeReasoner,
    private readonly logger: Logger
  ) {
    const appToken = process.env[config.slack.appTokenEnv];
    const botToken = process.env[config.slack.botTokenEnv];
    if (!appToken || !botToken) {
      throw new Error(
        `Missing Slack tokens. Expected envs ${config.slack.appTokenEnv} and ${config.slack.botTokenEnv}.`
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });

    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.app.start();
    this.logger.info("Slack socket mode app started");
  }

  private registerHandlers() {
    this.app.command("/agent-discover", async ({ ack, respond, command }) => {
      await ack();
      const actor = command.user_id;
      const channel = command.channel_id;
      const discovered = await this.discovery.discoverAndPersist();
      if (discovered.length === 0) {
        await respond("No git repositories found under configured discovery roots.");
        return;
      }

      const preview = discovered
        .slice(0, 20)
        .map((project) => `- ${project.name} (${project.path}) [${project.stackType}]`)
        .join("\n");

      await respond(
        `Discovered ${discovered.length} projects.\n${codeBlock(preview)}\nActor: <@${actor}>`
      );
      this.logger.info("Discovery triggered from Slack", { actor, channel });
    });

    this.app.command("/agent-status", async ({ ack, respond }) => {
      await ack();

      const projects = this.db.listProjects();
      const pending = this.db.listPendingApprovals();
      const projectLines =
        projects.length === 0
          ? "_No projects tracked yet_"
          : projects
              .slice(0, 20)
              .map(
                (project) =>
                  `- ${project.name}: ${project.status}, ${project.stackType}, ${project.domain} -> ${
                    project.port ?? "n/a"
                  }`
              )
              .join("\n");

      const pendingLines =
        pending.length === 0
          ? "_No pending approvals_"
          : pending
              .map(
                (item) =>
                  `- ${item.id}: ${item.riskLevel} by <@${item.actor}> -> ${item.command}`
              )
              .join("\n");

      await respond(
        `*Projects*\n${projectLines}\n\n*Pending approvals*\n${pendingLines}`
      );
    });

    this.app.command("/agent-shell", async ({ ack, respond, command }) => {
      await ack();
      const text = command.text?.trim();
      if (!text) {
        await respond("Usage: `/agent-shell <command>`");
        return;
      }

      const result = await this.shell.run({
        actor: command.user_id,
        channel: command.channel_id,
        source: "slash",
        command: text,
      });
      await respond(summarizeCommandResult(result));
    });

    this.app.command("/agent-approve", async ({ ack, respond, command }) => {
      await ack();
      const requestId = command.text.trim();
      if (!requestId) {
        await respond("Usage: `/agent-approve <request-id>`");
        return;
      }

      const executed = await this.shell.approveAndRun(requestId, command.user_id);
      if (!executed) {
        await respond(`Approval request not found or not pending: \`${requestId}\``);
        return;
      }

      await respond(
        `Approval executed for \`${requestId}\`.\n${summarizeCommandResult(executed)}`
      );
    });

    this.app.command("/agent-deny", async ({ ack, respond, command }) => {
      await ack();

      const parts = command.text.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      if (!action || action === "list") {
        const rules = this.policy.listRules();
        if (rules.length === 0) {
          await respond("No deny rules configured.");
          return;
        }
        const formatted = rules
          .map(
            (rule) =>
              `- ${rule.id} [${rule.kind}] ${rule.enabled ? "enabled" : "disabled"} :: ${rule.pattern}`
          )
          .join("\n");
        await respond(`Current deny rules:\n${codeBlock(formatted)}`);
        return;
      }

      if (action === "add") {
        const kind = parts[1] === "token" ? "token" : "regex";
        const pattern = parts.slice(kind === "token" || parts[1] === "regex" ? 2 : 1).join(" ");
        if (!pattern) {
          await respond("Usage: `/agent-deny add [regex|token] <pattern>`");
          return;
        }
        await this.policy.addRule({
          kind,
          pattern,
          description: `Added by Slack user ${command.user_id}`,
        });
        await respond(`Added deny rule (${kind}): \`${pattern}\``);
        return;
      }

      if (action === "remove") {
        const ruleId = parts[1];
        if (!ruleId) {
          await respond("Usage: `/agent-deny remove <rule-id>`");
          return;
        }
        const removed = await this.policy.removeRule(ruleId);
        await respond(
          removed
            ? `Removed deny rule: \`${ruleId}\``
            : `Rule not found: \`${ruleId}\``
        );
        return;
      }

      await respond("Usage: `/agent-deny [list|add|remove] ...`");
    });

    this.app.command("/agent-deploy", async ({ ack, respond, command }) => {
      await ack();

      const [target, branch] = command.text.trim().split(/\s+/);
      if (!target) {
        await respond("Usage: `/agent-deploy <repo-url-or-path> [branch]`");
        return;
      }

      const result = await this.deploy.deploy(
        target,
        command.user_id,
        command.channel_id,
        branch
      );
      await respond(result.message);
    });

    this.app.command("/agent-skill", async ({ ack, respond, command }) => {
      await ack();
      const parts = command.text.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "list";

      if (action === "list") {
        const skills = await this.skills.listSkills();
        if (skills.length === 0) {
          await respond("No skills found in configured skills directory.");
          return;
        }
        const lines = skills
          .map(
            (skill) =>
              `- ${skill.name}: ${skill.summary}${skill.hasScripts ? "" : " (no scripts)"}`
          )
          .join("\n");
        await respond(`Available skills:\n${lines}`);
        return;
      }

      if (action === "run") {
        const skillName = parts[1];
        if (!skillName) {
          await respond("Usage: `/agent-skill run <skill-name> [script] [args...]`");
          return;
        }
        const args = parts.slice(2);
        const result = await this.skills.runSkill(
          skillName,
          args,
          command.user_id,
          command.channel_id
        );
        if ("status" in result && result.status === "failed" && "error" in result) {
          await respond(`Skill execution failed: ${result.error}`);
          return;
        }
        await respond(summarizeCommandResult(result as CommandResult));
        return;
      }

      await respond("Usage: `/agent-skill [list|run] ...`");
    });

    this.app.event("app_mention", async ({ event, say }) => {
      const text = stripMention(event.text ?? "");
      if (!text) {
        await say("I can help with discovery, deploy, shell commands, debugging, and skills.");
        return;
      }

      const lower = text.toLowerCase();
      if (lower.startsWith("discover")) {
        const discovered = await this.discovery.discoverAndPersist();
        await say(`Discovered ${discovered.length} projects.`);
        return;
      }

      if (lower.startsWith("deploy ")) {
        const mentionParts = text.split(/\s+/);
        const target = mentionParts[1];
        const branch = mentionParts[2];
        if (!target) {
          await say("Usage: `deploy <repo-url-or-path> [branch]`");
          return;
        }
        if (!event.user || !event.channel) {
          await say("Cannot determine Slack user/channel context for this request.");
          return;
        }
        const result = await this.deploy.deploy(
          target,
          event.user,
          event.channel,
          branch
        );
        await say(result.message);
        return;
      }

      if (lower.startsWith("shell ")) {
        const command = text.slice("shell ".length).trim();
        if (!event.user || !event.channel) {
          await say("Cannot determine Slack user/channel context for this request.");
          return;
        }
        const result = await this.shell.run({
          actor: event.user,
          channel: event.channel,
          source: "mention",
          command,
        });
        await say(summarizeCommandResult(result));
        return;
      }

      if (lower.startsWith("status")) {
        const projects = this.db.listProjects();
        const lines = projects
          .slice(0, 10)
          .map(
            (project) =>
              `- ${project.name}: ${project.status}, ${project.domain} -> ${
                project.port ?? "n/a"
              }`
          )
          .join("\n");
        await say(lines || "No projects tracked yet.");
        return;
      }

      const projects = this.db.listProjects();
      const context = projects
        .slice(0, 20)
        .map(
          (project) =>
            `${project.name} | ${project.path} | ${project.stackType} | ${project.status} | ${project.domain} -> ${project.port ?? "n/a"}`
        )
        .join("\n");

      const prompt =
        `User asked in Slack: "${text}"\n\n` +
        `Known VPS projects:\n${context || "No projects discovered yet."}\n\n` +
        `Answer with concrete debugging/deployment guidance and call out assumptions.`;

      const answer = await this.reasoner.ask(prompt);
      await say(answer || "I could not generate a response.");
    });
  }
}
