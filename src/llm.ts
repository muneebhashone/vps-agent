import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { AuditService } from "./audit";
import type { Logger } from "./logger";
import type { AppConfig } from "./types";

function parseModel(model: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = model.split("/");
  if (!providerID || rest.length === 0) {
    throw new Error(
      `Invalid model format "${model}". Expected provider/model-id format.`
    );
  }

  return {
    providerID,
    modelID: rest.join("/"),
  };
}

function collectText(parts: Array<{ type?: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export class OpencodeReasoner {
  private client: OpencodeClient | null = null;
  private sessionId: string | null = null;
  private closeServer: (() => void) | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly audit: AuditService
  ) {}

  async ask(question: string, systemPrompt?: string): Promise<string> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "llm",
      action: "prompt_started",
      status: "started",
      requestSource: "system",
      requestText: question,
      meta: { model: this.config.opencode.modelPrimary },
    });
    await this.ensureReady();

    if (!this.client || !this.sessionId) {
      throw new Error("OpenCode client is not initialized.");
    }

    try {
      const response = await this.client.session.prompt({
        path: { id: this.sessionId },
        body: {
          system:
            systemPrompt ??
            "You are a VPS operations assistant. Provide concise, actionable answers with explicit commands when relevant.",
          model: parseModel(this.config.opencode.modelPrimary),
          parts: [
            {
              type: "text",
              text: question,
            },
          ],
        },
      });

      if ("data" in response && response.data) {
        const text = collectText(response.data.parts as Array<{ type?: string; text?: string }>);
        if (text) {
          this.audit.record({
            eventId,
            component: "llm",
            action: "prompt_completed",
            status: "completed",
            requestSource: "system",
            requestText: question,
            meta: { model: this.config.opencode.modelPrimary, responseLength: text.length },
          });
          return text;
        }
      }

      const fallbackMessage = await this.readLatestAssistantMessage();
      this.audit.record({
        eventId,
        component: "llm",
        action: "prompt_completed",
        status: "completed",
        requestSource: "system",
        requestText: question,
        meta: {
          model: this.config.opencode.modelPrimary,
          responseLength: fallbackMessage.length,
        },
      });
      return fallbackMessage;
    } catch (error) {
      this.logger.warn("Primary model failed, trying fallback model", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.audit.record({
        eventId,
        component: "llm",
        action: "primary_model_failed",
        status: "failed",
        requestSource: "system",
        requestText: question,
        meta: {
          model: this.config.opencode.modelPrimary,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      const fallback = this.config.opencode.modelFallback;
      if (!fallback || fallback === this.config.opencode.modelPrimary) {
        throw error;
      }

      const response = await this.client.session.prompt({
        path: { id: this.sessionId },
        body: {
          system:
            systemPrompt ??
            "You are a VPS operations assistant. Provide concise, actionable answers with explicit commands when relevant.",
          model: parseModel(fallback),
          parts: [{ type: "text", text: question }],
        },
      });

      if ("data" in response && response.data) {
        const text = collectText(response.data.parts as Array<{ type?: string; text?: string }>);
        if (text) {
          this.audit.record({
            eventId,
            component: "llm",
            action: "fallback_prompt_completed",
            status: "completed",
            requestSource: "system",
            requestText: question,
            meta: { model: fallback, responseLength: text.length },
          });
          return text;
        }
      }
      const fallbackMessage = await this.readLatestAssistantMessage();
      this.audit.record({
        eventId,
        component: "llm",
        action: "fallback_prompt_completed",
        status: "completed",
        requestSource: "system",
        requestText: question,
        meta: { model: fallback, responseLength: fallbackMessage.length },
      });
      return fallbackMessage;
    }
  }

  async close(): Promise<void> {
    this.closeServer?.();
    this.closeServer = null;
    this.client = null;
    this.sessionId = null;
  }

  private async readLatestAssistantMessage(): Promise<string> {
    if (!this.client || !this.sessionId) {
      return "";
    }

    const messages = await this.client.session.messages({
      path: { id: this.sessionId },
      query: { limit: 20 },
    });

    if (!("data" in messages) || !messages.data) {
      return "";
    }

    const items = messages.data;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const parts = items[i].parts as Array<{ type?: string; text?: string }>;
      const text = collectText(parts);
      if (text) {
        return text;
      }
    }

    return "";
  }

  private async ensureReady(): Promise<void> {
    if (this.client && this.sessionId) {
      return;
    }

    const server = await createOpencode({
      config: {
        enabled_providers: ["openrouter"],
        model: this.config.opencode.modelPrimary,
      },
    });

    this.client = server.client;
    this.closeServer = server.server.close;

    const session = await this.client.session.create({
      body: { title: "vps-agent-slack-session" },
    });
    const sessionData = (session as { data?: { id?: string } }).data;
    if (!sessionData?.id) {
      throw new Error("Failed to create OpenCode session.");
    }
    this.sessionId = sessionData.id;
  }
}
