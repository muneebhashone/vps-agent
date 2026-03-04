import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditService } from "./audit";
import type { AgentDatabase } from "./db";
import type { Logger } from "./logger";
import type { AppConfig } from "./types";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class CaddyManager {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AgentDatabase,
    private readonly logger: Logger,
    private readonly audit: AuditService
  ) {}

  async applyRoutes(): Promise<{ ok: boolean; error?: string }> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "caddy",
      action: "apply_routes_started",
      status: "started",
      requestSource: "system",
      meta: { snippetPath: this.config.caddy.managedSnippetPath },
    });
    const projects = this.db.listProjects().filter((project) => project.port);
    const snippetPath = this.config.caddy.managedSnippetPath;

    const snippet = [
      "# Managed by vps-agent. Do not edit manually.",
      ...projects.map((project) =>
        `${project.domain} {\n  reverse_proxy 127.0.0.1:${project.port}\n}\n`
      ),
    ].join("\n");

    await mkdir(dirname(snippetPath), { recursive: true });

    let previous = "";
    try {
      previous = await readFile(snippetPath, "utf8");
    } catch {
      previous = "";
    }

    await writeFile(snippetPath, snippet, "utf8");

    const reload = await Bun.spawn(
      ["bash", "-lc", this.config.caddy.reloadCommand],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(reload.stdout).text(),
      new Response(reload.stderr).text(),
      reload.exited,
    ]);

    if (exitCode !== 0) {
      await writeFile(snippetPath, previous, "utf8");
      this.audit.record({
        eventId,
        component: "caddy",
        action: "apply_routes_failed",
        status: "failed",
        requestSource: "system",
        meta: { exitCode, stdout, stderr },
      });
      return {
        ok: false,
        error: `Failed to reload caddy (exit ${exitCode}): ${stderr || stdout}`,
      };
    }

    this.logger.info("Applied caddy routes", {
      routes: projects.map((project) => ({
        domain: project.domain,
        port: project.port,
      })),
      snippetPath,
      command: this.config.caddy.reloadCommand,
    });
    this.audit.record({
      eventId,
      component: "caddy",
      action: "apply_routes_completed",
      status: "completed",
      requestSource: "system",
      meta: {
        routeCount: projects.length,
        snippetPath,
        command: this.config.caddy.reloadCommand,
      },
    });

    return { ok: true };
  }

  async rollbackRoutes(previousContent: string): Promise<void> {
    const eventId = this.audit.createEventId();
    const snippetPath = this.config.caddy.managedSnippetPath;
    await mkdir(dirname(snippetPath), { recursive: true });
    await writeFile(snippetPath, previousContent, "utf8");

    await Bun.spawn(["bash", "-lc", this.config.caddy.reloadCommand], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    this.logger.warn("Rolled back caddy routes", {
      snippetPath: shellQuote(snippetPath),
    });
    this.audit.record({
      eventId,
      component: "caddy",
      action: "rollback_routes_completed",
      status: "completed",
      requestSource: "system",
      meta: { snippetPath, previousLength: previousContent.length },
    });
  }
}
