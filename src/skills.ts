import { access, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AuditService } from "./audit";
import type { Logger } from "./logger";
import type { ShellExecutor } from "./shell";
import type { AppConfig, CommandResult } from "./types";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SkillInfo {
  name: string;
  path: string;
  hasScripts: boolean;
  summary: string;
}

export class SkillManager {
  private readonly skillsRoot: string;

  constructor(
    private readonly config: AppConfig,
    private readonly shell: ShellExecutor,
    private readonly logger: Logger,
    private readonly audit: AuditService
  ) {
    this.skillsRoot = resolve(config.paths.skillsDir);
  }

  async listSkills(): Promise<SkillInfo[]> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "skills",
      action: "list_skills_started",
      status: "started",
      requestSource: "system",
      meta: { root: this.skillsRoot },
    });
    if (!(await exists(this.skillsRoot))) {
      this.audit.record({
        eventId,
        component: "skills",
        action: "list_skills_completed",
        status: "completed",
        requestSource: "system",
        meta: { root: this.skillsRoot, count: 0 },
      });
      return [];
    }

    const entries = await readdir(this.skillsRoot, { withFileTypes: true });
    const skills: SkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillPath = join(this.skillsRoot, entry.name);
      const skillDoc = join(skillPath, "SKILL.md");
      if (!(await exists(skillDoc))) {
        continue;
      }

      const scriptsPath = join(skillPath, "scripts");
      const hasScripts = await exists(scriptsPath);
      const summary = await this.readSkillSummary(skillDoc);
      skills.push({
        name: entry.name,
        path: skillPath,
        hasScripts,
        summary,
      });
    }

    const sorted = skills.sort((a, b) => a.name.localeCompare(b.name));
    this.audit.record({
      eventId,
      component: "skills",
      action: "list_skills_completed",
      status: "completed",
      requestSource: "system",
      meta: { root: this.skillsRoot, count: sorted.length },
    });
    return sorted;
  }

  async runSkill(
    skillName: string,
    args: string[],
    actor: string,
    channel: string
  ): Promise<CommandResult | { status: "failed"; error: string }> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "skills",
      action: "run_skill_started",
      status: "started",
      actor,
      channel,
      requestSource: "slash",
      requestText: skillName,
      meta: { args },
    });
    const skillPath = join(this.skillsRoot, skillName);
    const docPath = join(skillPath, "SKILL.md");
    if (!(await exists(docPath))) {
      this.audit.record({
        eventId,
        component: "skills",
        action: "run_skill_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: skillName,
        meta: { reason: "skill_not_found" },
      });
      return { status: "failed", error: `Skill not found: ${skillName}` };
    }

    const scriptsPath = join(skillPath, "scripts");
    if (!(await exists(scriptsPath))) {
      this.audit.record({
        eventId,
        component: "skills",
        action: "run_skill_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: skillName,
        meta: { reason: "missing_scripts_directory", path: scriptsPath },
      });
      return {
        status: "failed",
        error:
          `Skill ${skillName} has no scripts directory. Read ${docPath} and execute manually.`,
      };
    }

    const scriptEntries = await readdir(scriptsPath, { withFileTypes: true });
    const scriptFiles = scriptEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    if (scriptFiles.length === 0) {
      this.audit.record({
        eventId,
        component: "skills",
        action: "run_skill_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: skillName,
        meta: { reason: "no_script_files", path: scriptsPath },
      });
      return {
        status: "failed",
        error: `Skill ${skillName} has no executable scripts in ${scriptsPath}.`,
      };
    }

    const requestedScript = args[0];
    const selected =
      requestedScript && scriptFiles.includes(requestedScript)
        ? requestedScript
        : scriptFiles[0];

    const passthroughArgs =
      requestedScript && selected === requestedScript ? args.slice(1) : args;
    const argString = passthroughArgs.map(shellQuote).join(" ");

    const run = await this.shell.run({
      actor,
      channel,
      source: "slash",
      cwd: skillPath,
      command: `bash ${shellQuote(join("scripts", selected))}${argString ? ` ${argString}` : ""}`,
    });

    this.logger.info("Skill executed", {
      skill: skillName,
      script: selected,
      actor,
      channel,
      status: run.status,
    });
    this.audit.record({
      eventId,
      component: "skills",
      action: "run_skill_completed",
      status: run.status === "completed" ? "completed" : "failed",
      actor,
      channel,
      requestSource: "slash",
      requestText: skillName,
      meta: { script: selected, result: run },
    });
    return run;
  }

  private async readSkillSummary(docPath: string): Promise<string> {
    try {
      const raw = await readFile(docPath, "utf8");
      const line = raw
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry && !entry.startsWith("#"));
      if (line) {
        return line.slice(0, 140);
      }
      return `Skill at ${basename(docPath)}`;
    } catch {
      return "No summary available";
    }
  }
}
