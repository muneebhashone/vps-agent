import { App } from "@slack/bolt";
import type { AuditService } from "./audit";
import type { AgentDatabase } from "./db";
import type { DeployManager } from "./deploy";
import type { ProjectDiscoveryService } from "./discovery";
import type { Logger } from "./logger";
import type { OpencodeReasoner } from "./llm";
import type { PolicyEngine } from "./policy";
import { redactSecretsInString } from "./redaction";
import {
  buildBlocksMessage,
  buildCommandResultMessage,
  buildProcessingMessage,
  type SlackMessagePayload,
} from "./slack-format";
import type { ShellExecutor } from "./shell";
import type { SkillManager } from "./skills";
import type { AppConfig, CommandResult } from "./types";

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    private readonly logger: Logger,
    private readonly audit: AuditService
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
    this.app.error(async (error) => {
      const eventId = this.audit.createEventId();
      const message = asErrorMessage(error);
      this.logger.error("Unhandled Slack error", { error: message });
      this.audit.record({
        eventId,
        component: "slack",
        action: "unhandled_error",
        status: "failed",
        requestSource: "system",
        meta: { error: message },
      });
    });

    this.app.command("/agent-discover", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "discover",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const discovered = await this.discovery.discoverAndPersist();
          if (discovered.length === 0) {
            return buildBlocksMessage(
              "Discovery",
              "No git repositories found under configured discovery roots."
            );
          }

          const preview = discovered
            .slice(0, 20)
            .map((project) => `- ${project.name} (${project.path}) [${project.stackType}]`)
            .join("\n");
          return buildBlocksMessage(
            "Discovery",
            `Discovered ${discovered.length} projects.`,
            preview
          );
        },
      });
    });

    this.app.command("/agent-status", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "status",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const projects = this.db.listProjects();
          const pending = this.db.listPendingApprovals();

          const projectLines =
            projects.length === 0
              ? "No projects tracked yet."
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
              ? "No pending approvals."
              : pending
                  .map(
                    (item) =>
                      `- ${item.id}: ${item.riskLevel} by <@${item.actor}> -> ${item.command}`
                  )
                  .join("\n");

          return buildBlocksMessage(
            "Status",
            `Projects: ${projects.length} | Pending approvals: ${pending.length}`,
            `${projectLines}\n\n${pendingLines}`
          );
        },
      });
    });

    this.app.command("/agent-shell", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "shell",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const text = command.text?.trim();
          if (!text) {
            return buildBlocksMessage("Shell", "Usage: `/agent-shell <command>`");
          }

          const result = await this.shell.run({
            actor: command.user_id,
            channel: command.channel_id,
            source: "slash",
            command: text,
          });
          return buildCommandResultMessage(result);
        },
      });
    });

    this.app.command("/agent-approve", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "approve",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const requestId = command.text.trim();
          if (!requestId) {
            return buildBlocksMessage(
              "Approve",
              "Usage: `/agent-approve <request-id>`"
            );
          }

          const executed = await this.shell.approveAndRun(requestId, command.user_id);
          if (!executed) {
            return buildBlocksMessage(
              "Approve",
              `Approval request not found or not pending: ${requestId}`
            );
          }

          return buildBlocksMessage(
            "Approve",
            `Approval executed for ${requestId}`,
            buildCommandResultMessage(executed).text
          );
        },
      });
    });

    this.app.command("/agent-deny", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "deny",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const parts = command.text.trim().split(/\s+/).filter(Boolean);
          const action = parts[0];

          if (!action || action === "list") {
            const rules = this.policy.listRules();
            if (rules.length === 0) {
              return buildBlocksMessage("Deny Rules", "No deny rules configured.");
            }
            const formatted = rules
              .map(
                (rule) =>
                  `- ${rule.id} [${rule.kind}] ${rule.enabled ? "enabled" : "disabled"} :: ${rule.pattern}`
              )
              .join("\n");
            return buildBlocksMessage("Deny Rules", "Current deny rules.", formatted);
          }

          if (action === "add") {
            const kind = parts[1] === "token" ? "token" : "regex";
            const pattern = parts
              .slice(kind === "token" || parts[1] === "regex" ? 2 : 1)
              .join(" ");
            if (!pattern) {
              return buildBlocksMessage(
                "Deny Rules",
                "Usage: `/agent-deny add [regex|token] <pattern>`"
              );
            }
            await this.policy.addRule({
              kind,
              pattern,
              description: `Added by Slack user ${command.user_id}`,
            });
            return buildBlocksMessage(
              "Deny Rules",
              `Added deny rule (${kind}): ${pattern}`
            );
          }

          if (action === "remove") {
            const ruleId = parts[1];
            if (!ruleId) {
              return buildBlocksMessage(
                "Deny Rules",
                "Usage: `/agent-deny remove <rule-id>`"
              );
            }
            const removed = await this.policy.removeRule(ruleId);
            return buildBlocksMessage(
              "Deny Rules",
              removed ? `Removed deny rule: ${ruleId}` : `Rule not found: ${ruleId}`
            );
          }

          return buildBlocksMessage("Deny Rules", "Usage: `/agent-deny [list|add|remove] ...`");
        },
      });
    });

    this.app.command("/agent-deploy", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "deploy",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const [target, branch] = command.text.trim().split(/\s+/);
          if (!target) {
            return buildBlocksMessage(
              "Deploy",
              "Usage: `/agent-deploy <repo-url-or-path> [branch]`"
            );
          }

          const result = await this.deploy.deploy(
            target,
            command.user_id,
            command.channel_id,
            branch
          );
          return buildBlocksMessage(
            result.success ? "Deploy completed" : "Deploy failed",
            result.message
          );
        },
      });
    });

    this.app.command("/agent-skill", async ({ ack, respond, command }) => {
      await this.handleSlash({
        action: "skill",
        actor: command.user_id,
        channel: command.channel_id,
        text: command.text,
        ack,
        respond,
        handler: async () => {
          const parts = command.text.trim().split(/\s+/).filter(Boolean);
          const action = parts[0] ?? "list";

          if (action === "list") {
            const skills = await this.skills.listSkills();
            if (skills.length === 0) {
              return buildBlocksMessage(
                "Skills",
                "No skills found in configured skills directory."
              );
            }
            const lines = skills
              .map(
                (skill) =>
                  `- ${skill.name}: ${skill.summary}${skill.hasScripts ? "" : " (no scripts)"}`
              )
              .join("\n");
            return buildBlocksMessage("Skills", "Available skills.", lines);
          }

          if (action === "run") {
            const skillName = parts[1];
            if (!skillName) {
              return buildBlocksMessage(
                "Skills",
                "Usage: `/agent-skill run <skill-name> [script] [args...]`"
              );
            }
            const args = parts.slice(2);
            const result = await this.skills.runSkill(
              skillName,
              args,
              command.user_id,
              command.channel_id
            );
            if ("status" in result && result.status === "failed" && "error" in result) {
              return buildBlocksMessage("Skills", `Skill execution failed: ${result.error}`);
            }
            return buildCommandResultMessage(result as CommandResult);
          }

          return buildBlocksMessage("Skills", "Usage: `/agent-skill [list|run] ...`");
        },
      });
    });

    this.app.event("app_mention", async ({ event, say }) => {
      const eventId = this.audit.createEventId();
      const text = stripMention(event.text ?? "");
      const actor = event.user;
      const channel = event.channel;
      const threadTs = event.thread_ts ?? event.ts;

      this.audit.record({
        eventId,
        component: "slack",
        action: "mention_received",
        status: "started",
        actor,
        channel,
        requestSource: "mention",
        requestText: text,
      });

      if (!text) {
        await this.sayThread(
          say,
          threadTs,
          buildBlocksMessage(
            "Agent",
            "I can help with discovery, deploy, shell commands, debugging, and skills."
          )
        );
        return;
      }

      await this.sayThread(say, threadTs, buildProcessingMessage());
      this.audit.record({
        eventId,
        component: "slack",
        action: "processing_indicator_sent",
        status: "info",
        actor,
        channel,
        requestSource: "mention",
        requestText: text,
      });

      try {
        const lower = text.toLowerCase();
        if (lower.startsWith("discover")) {
          const discovered = await this.discovery.discoverAndPersist();
          await this.sayThread(
            say,
            threadTs,
            buildBlocksMessage(
              "Discovery",
              `Discovered ${discovered.length} projects.`
            )
          );
          this.audit.record({
            eventId,
            component: "slack",
            action: "mention_response_sent",
            status: "completed",
            actor,
            channel,
            requestSource: "mention",
            requestText: text,
          });
          return;
        }

        if (lower.startsWith("deploy ")) {
          const mentionParts = text.split(/\s+/);
          const target = mentionParts[1];
          const branch = mentionParts[2];
          if (!target || !actor || !channel) {
            await this.sayThread(
              say,
              threadTs,
              buildBlocksMessage(
                "Deploy",
                !target
                  ? "Usage: `deploy <repo-url-or-path> [branch]`"
                  : "Cannot determine Slack user/channel context for this request."
              )
            );
            return;
          }
          const result = await this.deploy.deploy(target, actor, channel, branch);
          await this.sayThread(
            say,
            threadTs,
            buildBlocksMessage(
              result.success ? "Deploy completed" : "Deploy failed",
              result.message
            )
          );
          return;
        }

        if (lower.startsWith("shell ")) {
          const command = text.slice("shell ".length).trim();
          if (!actor || !channel) {
            await this.sayThread(
              say,
              threadTs,
              buildBlocksMessage(
                "Shell",
                "Cannot determine Slack user/channel context for this request."
              )
            );
            return;
          }
          const result = await this.shell.run({
            actor,
            channel,
            source: "mention",
            command,
          });
          await this.sayThread(say, threadTs, buildCommandResultMessage(result));
          return;
        }

        if (lower.startsWith("status")) {
          const projects = this.db.listProjects();
          const lines = projects
            .slice(0, 10)
            .map(
              (project) =>
                `- ${project.name}: ${project.status}, ${project.domain} -> ${project.port ?? "n/a"}`
            )
            .join("\n");
          await this.sayThread(
            say,
            threadTs,
            buildBlocksMessage("Status", lines || "No projects tracked yet.")
          );
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
        await this.sayThread(
          say,
          threadTs,
          buildBlocksMessage("Agent answer", answer || "I could not generate a response.")
        );
        this.audit.record({
          eventId,
          component: "slack",
          action: "mention_response_sent",
          status: "completed",
          actor,
          channel,
          requestSource: "mention",
          requestText: text,
        });
      } catch (error) {
        const message = asErrorMessage(error);
        this.logger.error("Mention handling failed", { error: message });
        this.audit.record({
          eventId,
          component: "slack",
          action: "mention_failed",
          status: "failed",
          actor,
          channel,
          requestSource: "mention",
          requestText: text,
          meta: { error: message },
        });
        await this.sayThread(
          say,
          threadTs,
          buildBlocksMessage("Agent error", `Request failed: ${message}`)
        );
      }
    });
  }

  private async handleSlash(input: {
    action: string;
    actor: string;
    channel: string;
    text?: string;
    ack: () => Promise<void>;
    respond: (body: any) => Promise<any>;
    handler: () => Promise<SlackMessagePayload>;
  }) {
    const eventId = this.audit.createEventId();
    const started = Date.now();
    this.audit.record({
      eventId,
      component: "slack",
      action: `slash_${input.action}_received`,
      status: "started",
      actor: input.actor,
      channel: input.channel,
      requestSource: "slash",
      requestText: input.text ?? "",
    });

    await input.ack();
    this.audit.record({
      eventId,
      component: "slack",
      action: `slash_${input.action}_acked`,
      status: "info",
      actor: input.actor,
      channel: input.channel,
      requestSource: "slash",
      requestText: input.text ?? "",
    });

    await this.respondEphemeral(input.respond, buildProcessingMessage());
    this.audit.record({
      eventId,
      component: "slack",
      action: `slash_${input.action}_processing_indicator_sent`,
      status: "info",
      actor: input.actor,
      channel: input.channel,
      requestSource: "slash",
      requestText: input.text ?? "",
    });

    try {
      const message = await input.handler();
      await this.respondEphemeral(input.respond, message);
      this.audit.record({
        eventId,
        component: "slack",
        action: `slash_${input.action}_response_sent`,
        status: "completed",
        actor: input.actor,
        channel: input.channel,
        requestSource: "slash",
        requestText: input.text ?? "",
        meta: { elapsedMs: Date.now() - started, text: redactSecretsInString(message.text) },
      });
    } catch (error) {
      const message = asErrorMessage(error);
      this.logger.error("Slash command handling failed", {
        action: input.action,
        error: message,
      });
      this.audit.record({
        eventId,
        component: "slack",
        action: `slash_${input.action}_failed`,
        status: "failed",
        actor: input.actor,
        channel: input.channel,
        requestSource: "slash",
        requestText: input.text ?? "",
        meta: { elapsedMs: Date.now() - started, error: message },
      });
      await this.respondEphemeral(
        input.respond,
        buildBlocksMessage("Agent error", `Request failed: ${message}`)
      );
    }
  }

  private async respondEphemeral(
    respond: (body: any) => Promise<any>,
    payload: SlackMessagePayload
  ): Promise<void> {
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: payload.text,
      blocks: payload.blocks,
    });
  }

  private async sayThread(
    say: (body: any) => Promise<any>,
    threadTs: string | undefined,
    payload: SlackMessagePayload
  ): Promise<void> {
    await say({
      text: payload.text,
      blocks: payload.blocks,
      thread_ts: threadTs,
    });
  }
}
