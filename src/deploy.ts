import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import type { AuditService } from "./audit";
import type { CaddyManager } from "./caddy";
import type { AgentDatabase } from "./db";
import type { ProjectDiscoveryService } from "./discovery";
import type { Logger } from "./logger";
import { redactSecretsInString } from "./redaction";
import type { ShellExecutor } from "./shell";
import type { AppConfig, DeployResult, ProjectRecord } from "./types";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isGitUrl(input: string): boolean {
  return (
    input.startsWith("https://") ||
    input.startsWith("http://") ||
    input.startsWith("git@")
  );
}

function isGitHubHttpsUrl(repoUrl: string): boolean {
  return /^https?:\/\/github\.com\//i.test(repoUrl);
}

function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/[^@\s/]+@/i, "https://");
}

function applyGitHubToken(repoUrl: string): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token || !isGitHubHttpsUrl(repoUrl)) {
    return repoUrl;
  }

  const normalized = normalizeRepoUrl(repoUrl);
  return normalized.replace(
    /^https?:\/\//i,
    `https://x-access-token:${encodeURIComponent(token)}@`
  );
}

function projectNameFromInput(value: string): string {
  const base = value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()!
    .replace(/\.git$/, "");

  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function failureReason(
  stderr?: string,
  error?: string,
  blockedBy?: string,
  fallback = "unknown error"
): string {
  return redactSecretsInString(stderr || error || blockedBy || fallback);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(
  start: number,
  end: number,
  blocked: Set<number>
): Promise<number | null> {
  for (let port = start; port <= end; port += 1) {
    if (blocked.has(port)) {
      continue;
    }

    const free = await new Promise<boolean>((resolvePromise) => {
      const server = net.createServer();
      server.once("error", () => resolvePromise(false));
      server.once("listening", () => {
        server.close(() => resolvePromise(true));
      });
      server.listen(port, "127.0.0.1");
    });

    if (free) {
      return port;
    }
  }

  return null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling
    }
    await Bun.sleep(2_000);
  }

  return false;
}

function parseComposePublishedPort(raw: string): number | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const jsonPorts: number[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        Publishers?: Array<{ PublishedPort?: number }>;
      };
      for (const publisher of parsed.Publishers ?? []) {
        if (publisher.PublishedPort) {
          jsonPorts.push(publisher.PublishedPort);
        }
      }
    } catch {
      // not json line
    }
  }

  if (jsonPorts.length > 0) {
    return jsonPorts[0];
  }

  const regex = /0\.0\.0\.0:(\d+)->/g;
  const matches = [...raw.matchAll(regex)];
  if (matches.length > 0) {
    return Number(matches[0][1]);
  }

  return undefined;
}

export class DeployManager {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AgentDatabase,
    private readonly shell: ShellExecutor,
    private readonly discovery: ProjectDiscoveryService,
    private readonly caddy: CaddyManager,
    private readonly logger: Logger,
    private readonly audit: AuditService
  ) {}

  async deploy(
    repoOrPath: string,
    actor: string,
    channel: string,
    branch?: string
  ): Promise<DeployResult> {
    const eventId = this.audit.createEventId();
    this.audit.record({
      eventId,
      component: "deploy",
      action: "deploy_started",
      status: "started",
      actor,
      channel,
      requestSource: "slash",
      requestText: repoOrPath,
      meta: { branch },
    });

    const resolution = await this.resolveProjectPath(
      repoOrPath,
      actor,
      channel,
      branch,
      eventId
    );
    if (!resolution.success) {
      this.audit.record({
        eventId,
        component: "deploy",
        action: "deploy_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { branch, reason: resolution.message },
      });
      return resolution;
    }
    if (!resolution.path) {
      this.audit.record({
        eventId,
        component: "deploy",
        action: "deploy_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { branch, reason: "project_path_resolution_missing" },
      });
      return {
        success: false,
        message: "Project path resolution failed unexpectedly.",
      };
    }

    const projectPath = resolution.path;
    const projectName = projectNameFromInput(projectPath);
    const domain = `${projectName}.${this.config.projects.baseDomain}`;
    const detection = await this.discovery.detectProject(projectPath);
    this.audit.record({
      eventId,
      component: "deploy",
      action: "stack_detected",
      status: "completed",
      actor,
      channel,
      requestSource: "slash",
      requestText: repoOrPath,
      meta: {
        projectPath,
        stack: detection.stack,
        runModel: detection.runModel,
        reason: detection.reason,
      },
    });

    const baseProject: Omit<ProjectRecord, "updatedAt"> = {
      name: projectName,
      path: projectPath,
      repoUrl: resolution.repoUrl,
      branch: branch,
      stackType: detection.stack,
      runModel: detection.runModel,
      domain,
      healthPath: this.config.projects.defaultHealthPath,
      status: "unknown",
      port: undefined,
    };

    if (detection.runModel === "manual" || detection.runModel === "adapter") {
      this.db.upsertProject(baseProject);
      this.db.recordDeployment(
        projectName,
        "failed",
        `Detected ${detection.stack} stack (${detection.reason}) but deploy automation is only implemented for docker/docker-compose in this version.`
      );
      this.audit.record({
        eventId,
        component: "deploy",
        action: "deploy_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: {
          projectName,
          stack: detection.stack,
          runModel: detection.runModel,
          reason: detection.reason,
        },
      });
      return {
        success: false,
        message:
          `Detected ${detection.stack} stack but automated deploy is not configured yet. ` +
          `Use /agent-shell with explicit build/run commands or add project-specific skill.`,
      };
    }

    let port: number | undefined;
    let revision: string | undefined;
    let rollbackCommand: string | undefined;

    if (detection.runModel === "docker-compose") {
      this.audit.record({
        eventId,
        component: "deploy",
        action: "compose_up_started",
        status: "started",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { projectPath },
      });
      const up = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: projectPath,
        command: "docker compose up -d --build",
      });

      if (up.status !== "completed") {
        this.db.recordDeployment(
          projectName,
          "failed",
          `docker compose up failed: ${failureReason(up.stderr, up.error, up.blockedBy, "unknown")}`
        );
        this.audit.record({
          eventId,
          component: "deploy",
          action: "compose_up_failed",
          status: "failed",
          actor,
          channel,
          requestSource: "slash",
          requestText: repoOrPath,
          meta: { projectPath, result: up },
        });
        return {
          success: false,
          message: `Deploy failed while running docker compose up: ${failureReason(up.stderr, up.error, up.blockedBy)}`,
        };
      }

      rollbackCommand = "docker compose down";
      this.audit.record({
        eventId,
        component: "deploy",
        action: "compose_up_completed",
        status: "completed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { projectPath },
      });

      const portResult = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: projectPath,
        command: "docker compose ps --format json",
      });
      if (portResult.status === "completed") {
        port = parseComposePublishedPort(portResult.stdout ?? "");
      }
    }

    if (detection.runModel === "docker") {
      const usedPorts = new Set<number>(
        this.db
          .listProjects()
          .map((project) => project.port)
          .filter((p): p is number => typeof p === "number")
      );
      const freePort = await findFreePort(20000, 29999, usedPorts);
      if (!freePort) {
        this.audit.record({
          eventId,
          component: "deploy",
          action: "port_allocation_failed",
          status: "failed",
          actor,
          channel,
          requestSource: "slash",
          requestText: repoOrPath,
          meta: { range: "20000-29999" },
        });
        return { success: false, message: "No free port found in 20000-29999." };
      }
      port = freePort;

      const imageName = `vps-agent-${projectName}`;
      const containerName = `vps-agent-${projectName}`;
      rollbackCommand = `docker rm -f ${containerName} >/dev/null 2>&1 || true`;

      const build = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: projectPath,
        command: `docker build -t ${shellQuote(imageName)} .`,
      });
      if (build.status !== "completed") {
        this.audit.record({
          eventId,
          component: "deploy",
          action: "docker_build_failed",
          status: "failed",
          actor,
          channel,
          requestSource: "slash",
          requestText: repoOrPath,
          meta: { projectPath, result: build },
        });
        return {
          success: false,
          message: `docker build failed: ${failureReason(build.stderr, build.error, build.blockedBy)}`,
        };
      }

      const run = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: projectPath,
        command:
          `docker rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true && ` +
          `docker run -d --name ${shellQuote(containerName)} -p ${port}:${this.config.projects.defaultContainerInternalPort} ${shellQuote(imageName)}`,
      });
      if (run.status !== "completed") {
        this.audit.record({
          eventId,
          component: "deploy",
          action: "docker_run_failed",
          status: "failed",
          actor,
          channel,
          requestSource: "slash",
          requestText: repoOrPath,
          meta: { projectPath, result: run },
        });
        return {
          success: false,
          message: `docker run failed: ${failureReason(run.stderr, run.error, run.blockedBy)}`,
        };
      }
    }

    const revisionResult = await this.shell.run({
      actor,
      channel,
      source: "slash",
      cwd: projectPath,
      command: "git rev-parse --short HEAD",
    });
    if (revisionResult.status === "completed") {
      revision = revisionResult.stdout?.trim();
    }

    if (!port) {
      this.audit.record({
        eventId,
        component: "deploy",
        action: "port_detection_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { projectPath, runModel: detection.runModel },
      });
      return {
        success: false,
        message:
          "Deploy completed but no published host port was detected. Configure explicit port mapping and retry.",
      };
    }

    const healthUrl = `http://127.0.0.1:${port}${this.config.projects.defaultHealthPath}`;
    const healthy = await waitForHealth(
      healthUrl,
      this.config.projects.healthTimeoutMs
    );
    if (!healthy) {
      if (rollbackCommand) {
        await this.shell.run({
          actor,
          channel,
          source: "system",
          cwd: projectPath,
          command: rollbackCommand,
          bypassApproval: true,
        });
      }

      this.db.recordDeployment(
        projectName,
        "failed",
        `Healthcheck failed on ${healthUrl}`,
        revision
      );
      this.audit.record({
        eventId,
        component: "deploy",
        action: "healthcheck_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { healthUrl, revision, rollbackCommand },
      });
      return {
        success: false,
        message: `Healthcheck failed on ${healthUrl}; deployment rolled back.`,
      };
    }

    const project: Omit<ProjectRecord, "updatedAt"> = {
      ...baseProject,
      port,
      status: "running",
    };
    this.db.upsertProject(project);

    const caddyApply = await this.caddy.applyRoutes();
    if (!caddyApply.ok) {
      if (rollbackCommand) {
        await this.shell.run({
          actor,
          channel,
          source: "system",
          cwd: projectPath,
          command: rollbackCommand,
          bypassApproval: true,
        });
      }
      this.db.recordDeployment(
        projectName,
        "failed",
        `Caddy update failed: ${caddyApply.error}`,
        revision
      );
      this.audit.record({
        eventId,
        component: "deploy",
        action: "caddy_apply_failed",
        status: "failed",
        actor,
        channel,
        requestSource: "slash",
        requestText: repoOrPath,
        meta: { projectName, revision, error: caddyApply.error },
      });
      return {
        success: false,
        message: `Deploy failed while reloading caddy. Rollback executed. ${caddyApply.error}`,
      };
    }

    this.db.recordDeployment(
      projectName,
      "success",
      `Deployed at https://${domain} -> 127.0.0.1:${port}`,
      revision
    );
    this.logger.info("Deploy completed", { projectName, domain, port, revision });
    this.audit.record({
      eventId,
      component: "deploy",
      action: "deploy_completed",
      status: "completed",
      actor,
      channel,
      requestSource: "slash",
      requestText: repoOrPath,
      meta: { projectName, domain, port, revision },
    });

    return {
      success: true,
      message: `Deployed ${projectName} at https://${domain} (port ${port})`,
      project: { ...project, updatedAt: new Date().toISOString() },
    };
  }

  private async resolveProjectPath(
    repoOrPath: string,
    actor: string,
    channel: string,
    branch?: string,
    eventId?: string
  ): Promise<DeployResult & { path?: string; repoUrl?: string }> {
    if (!isGitUrl(repoOrPath)) {
      const absolute = resolve(repoOrPath);
      if (!(await exists(absolute))) {
        return {
          success: false,
          message: `Project path does not exist: ${absolute}`,
        };
      }
      return {
        success: true,
        message: "Using existing local project path.",
        path: absolute,
      };
    }

    await mkdir(this.config.paths.deployRoot, { recursive: true });
    const cleanRepoUrl = normalizeRepoUrl(repoOrPath);
    const repoUrlWithToken = applyGitHubToken(cleanRepoUrl);
    const projectName = projectNameFromInput(cleanRepoUrl);
    const targetPath = join(resolve(this.config.paths.deployRoot), projectName);
    const hasGit = await exists(join(targetPath, ".git"));
    if (eventId) {
      this.audit.record({
        eventId,
        component: "deploy",
        action: hasGit ? "repo_update_started" : "repo_clone_started",
        status: "started",
        actor,
        channel,
        requestSource: "slash",
        requestText: cleanRepoUrl,
        meta: { targetPath, branch: branch ?? "main" },
      });
    }

    if (!hasGit) {
      const clone = await this.shell.run({
        actor,
        channel,
        source: "slash",
        command: `git clone ${shellQuote(repoUrlWithToken)} ${shellQuote(targetPath)}`,
      });
      if (clone.status !== "completed") {
        if (eventId) {
          this.audit.record({
            eventId,
            component: "deploy",
            action: "repo_clone_failed",
            status: "failed",
            actor,
            channel,
            requestSource: "slash",
            requestText: cleanRepoUrl,
            meta: { targetPath, result: clone },
          });
        }
        return {
          success: false,
          message: `Failed to clone repo: ${failureReason(clone.stderr, clone.error, clone.blockedBy)}`,
        };
      }
    } else {
      const setRemote = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: targetPath,
        command: `git remote set-url origin ${shellQuote(repoUrlWithToken)}`,
      });
      if (setRemote.status !== "completed") {
        if (eventId) {
          this.audit.record({
            eventId,
            component: "deploy",
            action: "repo_update_failed",
            status: "failed",
            actor,
            channel,
            requestSource: "slash",
            requestText: cleanRepoUrl,
            meta: { targetPath, reason: "set_remote_failed", result: setRemote },
          });
        }
        return {
          success: false,
          message: `Failed to set repository origin URL: ${failureReason(setRemote.stderr, setRemote.error, setRemote.blockedBy)}`,
        };
      }

      const pull = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: targetPath,
        command: `git fetch --all --prune && git checkout ${shellQuote(branch ?? "main")} && git pull --ff-only`,
      });
      if (pull.status !== "completed") {
        if (eventId) {
          this.audit.record({
            eventId,
            component: "deploy",
            action: "repo_update_failed",
            status: "failed",
            actor,
            channel,
            requestSource: "slash",
            requestText: cleanRepoUrl,
            meta: { targetPath, branch: branch ?? "main", result: pull },
          });
        }
        return {
          success: false,
          message: `Failed to update repo: ${failureReason(pull.stderr, pull.error, pull.blockedBy)}`,
        };
      }
    }

    if (branch) {
      const checkout = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: targetPath,
        command: `git checkout ${shellQuote(branch)}`,
      });
      if (checkout.status !== "completed") {
        if (eventId) {
          this.audit.record({
            eventId,
            component: "deploy",
            action: "branch_checkout_failed",
            status: "failed",
            actor,
            channel,
            requestSource: "slash",
            requestText: cleanRepoUrl,
            meta: { targetPath, branch, result: checkout },
          });
        }
        return {
          success: false,
          message: `Failed to checkout branch ${branch}: ${failureReason(checkout.stderr, checkout.error, checkout.blockedBy)}`,
        };
      }
    }
    if (eventId) {
      this.audit.record({
        eventId,
        component: "deploy",
        action: hasGit ? "repo_update_completed" : "repo_clone_completed",
        status: "completed",
        actor,
        channel,
        requestSource: "slash",
        requestText: cleanRepoUrl,
        meta: { targetPath, branch: branch ?? "main" },
      });
    }

    return {
      success: true,
      message: `Prepared repository at ${targetPath}`,
      path: targetPath,
      repoUrl: cleanRepoUrl,
    };
  }
}
