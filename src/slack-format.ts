import { truncateText } from "./redaction";
import { redactSecretsInString } from "./redaction";
import type { CommandResult } from "./types";

export interface SlackMessagePayload {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export function escapeMrkdwn(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function section(text: string): Record<string, unknown> {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncateText(text, 2_800),
    },
  };
}

export function buildBlocksMessage(
  title: string,
  body: string,
  details?: string
): SlackMessagePayload {
  const blocks: Array<Record<string, unknown>> = [
    section(`*${escapeMrkdwn(title)}*`),
    section(escapeMrkdwn(body)),
  ];

  if (details?.trim()) {
    const safeDetails = details.trim().replace(/```/g, "'''");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${truncateText(safeDetails, 2_600)}\`\`\``,
      },
    });
  }

  return {
    text: `${title}: ${body}`,
    blocks,
  };
}

export function buildProcessingMessage(): SlackMessagePayload {
  return buildBlocksMessage("Processing", "Received. Processing your request now.");
}

export function buildCommandResultMessage(result: CommandResult): SlackMessagePayload {
  if (result.status === "approval_required") {
    return buildBlocksMessage(
      "Approval required",
      `Request ID: ${result.approvalId ?? "unknown"}`,
      redactSecretsInString(result.command)
    );
  }

  if (result.status === "denied") {
    return buildBlocksMessage(
      "Command denied",
      redactSecretsInString(result.blockedBy ?? "Blocked by policy."),
      redactSecretsInString(result.command)
    );
  }

  if (result.status === "failed") {
    return buildBlocksMessage(
      `Command failed (exit ${result.exitCode ?? "?"})`,
      "Execution returned a non-zero status.",
      redactSecretsInString(result.error ?? result.stderr ?? "No error output.")
    );
  }

  return buildBlocksMessage(
    `Command completed (exit ${result.exitCode ?? 0})`,
    "Execution finished successfully.",
    redactSecretsInString(result.stdout?.trim() || "No stdout output.")
  );
}
