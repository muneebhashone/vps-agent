import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "./db";
import type { Logger } from "./logger";
import { redactUnknown, truncateText } from "./redaction";
import type { AuditEventInput } from "./types";

export class AuditService {
  constructor(
    private readonly logger: Logger,
    private readonly db?: AgentDatabase
  ) {}

  createEventId(): string {
    return randomUUID();
  }

  record(input: AuditEventInput): void {
    const event = {
      ...input,
      status: input.status ?? "info",
      requestText:
        input.requestText && truncateText(String(redactUnknown(input.requestText))),
      meta: redactUnknown(input.meta),
    };

    this.logger.info("Audit event", event);
    this.db?.recordAuditEvent(event);
  }
}
