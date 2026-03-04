import { randomUUID } from "node:crypto";
import type { AuditService } from "./audit";
import type { AgentDatabase } from "./db";
import type { Logger } from "./logger";
import { redactSecretsInString } from "./redaction";
import type { PolicyEngine } from "./policy";
import type { CommandRequest, CommandResult } from "./types";

export class ShellExecutor {
  constructor(
    private readonly policy: PolicyEngine,
    private readonly db: AgentDatabase,
    private readonly logger: Logger,
    private readonly audit: AuditService,
    private readonly requireApprovalForHighRisk: boolean
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "shell",
      action: "command_received",
      status: "started",
      actor: request.actor,
      channel: request.channel,
      requestSource: request.source,
      requestText: request.command,
      meta: { cwd: request.cwd, bypassApproval: request.bypassApproval },
    });
    const decision = this.policy.evaluate(request.command);

    if (!decision.allowed) {
      const denied: CommandResult = {
        status: "denied",
        command: request.command,
        riskLevel: decision.riskLevel,
        blockedBy: decision.blockedBy,
      };
      this.db.recordCommand(request.actor, request.channel, request.source, denied);
      this.audit.record({
        eventId,
        component: "shell",
        action: "command_denied",
        status: "failed",
        actor: request.actor,
        channel: request.channel,
        requestSource: request.source,
        requestText: request.command,
        meta: { blockedBy: decision.blockedBy, riskLevel: decision.riskLevel },
      });
      return denied;
    }

    if (
      decision.riskLevel === "high" &&
      this.requireApprovalForHighRisk &&
      !request.bypassApproval
    ) {
      const approvalId = `apr-${randomUUID().slice(0, 10)}`;
      this.db.createApproval({
        id: approvalId,
        actor: request.actor,
        channel: request.channel,
        source: request.source,
        command: request.command,
        riskLevel: decision.riskLevel,
      });

      const waiting: CommandResult = {
        status: "approval_required",
        command: request.command,
        riskLevel: decision.riskLevel,
        approvalId,
      };
      this.db.recordCommand(request.actor, request.channel, request.source, waiting);
      this.audit.record({
        eventId,
        component: "shell",
        action: "approval_required",
        status: "info",
        actor: request.actor,
        channel: request.channel,
        requestSource: request.source,
        requestText: request.command,
        meta: { approvalId, riskLevel: decision.riskLevel },
      });
      return waiting;
    }

    return this.execute(request, decision.riskLevel, eventId);
  }

  async approveAndRun(
    approvalId: string,
    approvedBy: string
  ): Promise<CommandResult | null> {
    const approval = this.db.getApproval(approvalId);
    if (!approval || approval.status !== "pending") {
      return null;
    }

    this.db.setApprovalStatus(approvalId, "approved", approvedBy);
    const result = await this.execute(
      {
        actor: approval.actor,
        channel: approval.channel,
        source: approval.source as "slash" | "mention" | "system",
        command: approval.command,
        bypassApproval: true,
      },
      approval.riskLevel,
      this.audit.createEventId()
    );
    this.db.setApprovalStatus(approvalId, "executed", approvedBy);
    return result;
  }

  rejectApproval(approvalId: string, rejectedBy: string): boolean {
    const approval = this.db.getApproval(approvalId);
    if (!approval || approval.status !== "pending") {
      return false;
    }
    this.db.setApprovalStatus(approvalId, "rejected", rejectedBy);
    return true;
  }

  private async execute(
    request: CommandRequest,
    riskLevel: CommandResult["riskLevel"],
    eventId: string
  ): Promise<CommandResult> {
    this.logger.info("Executing shell command", {
      actor: request.actor,
      channel: request.channel,
      source: request.source,
      riskLevel,
      command: redactSecretsInString(request.command),
      cwd: request.cwd,
    });
    this.audit.record({
      eventId,
      component: "shell",
      action: "command_execution_started",
      status: "started",
      actor: request.actor,
      channel: request.channel,
      requestSource: request.source,
      requestText: request.command,
      meta: { riskLevel, cwd: request.cwd },
    });

    try {
      const proc = Bun.spawn(["bash", "-lc", request.command], {
        cwd: request.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const result: CommandResult = {
        status: exitCode === 0 ? "completed" : "failed",
        command: request.command,
        riskLevel,
        exitCode,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      };

      this.db.recordCommand(request.actor, request.channel, request.source, result);
      this.audit.record({
        eventId,
        component: "shell",
        action: "command_execution_completed",
        status: exitCode === 0 ? "completed" : "failed",
        actor: request.actor,
        channel: request.channel,
        requestSource: request.source,
        requestText: request.command,
        meta: {
          riskLevel,
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        },
      });
      return result;
    } catch (error) {
      const failed: CommandResult = {
        status: "failed",
        command: request.command,
        riskLevel,
        error: error instanceof Error ? error.message : String(error),
      };
      this.db.recordCommand(request.actor, request.channel, request.source, failed);
      this.audit.record({
        eventId,
        component: "shell",
        action: "command_execution_error",
        status: "failed",
        actor: request.actor,
        channel: request.channel,
        requestSource: request.source,
        requestText: request.command,
        meta: {
          riskLevel,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return failed;
    }
  }
}

function truncate(value: string, maxLen = 8_000): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen)}\n...<truncated>`;
}
