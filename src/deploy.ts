import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import type { CaddyManager } from "./caddy";
import type { AgentDatabase } from "./db";
import type { ProjectDiscoveryService } from "./discovery";
import type { Logger } from "./logger";
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

function gitBinaryForRepo(repoUrl: string): string {
  const hasToken = Boolean(process.env.GITHUB_TOKEN);
  const isGitHubHttps = /^https?:\/\/github\.com\//i.test(repoUrl);
  if (hasToken && isGitHubHttps) {
    return 'git -c http.extraHeader="Authorization: Bearer $GITHUB_TOKEN"';
  }
  return "git";
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
    private readonly logger: Logger
  ) {}

  async deploy(
    repoOrPath: string,
    actor: string,
    channel: string,
    branch?: string
  ): Promise<DeployResult> {
    const resolution = await this.resolveProjectPath(repoOrPath, actor, channel, branch);
    if (!resolution.success) {
      return resolution;
    }
    if (!resolution.path) {
      return {
        success: false,
        message: "Project path resolution failed unexpectedly.",
      };
    }

    const projectPath = resolution.path;
    const projectName = projectNameFromInput(projectPath);
    const domain = `${projectName}.${this.config.projects.baseDomain}`;
    const detection = await this.discovery.detectProject(projectPath);

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
          `docker compose up failed: ${up.stderr || up.error || up.blockedBy || "unknown"}`
        );
        return {
          success: false,
          message: `Deploy failed while running docker compose up: ${up.stderr || up.error || up.blockedBy || "unknown error"}`,
        };
      }

      rollbackCommand = "docker compose down";

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
        return {
          success: false,
          message: `docker build failed: ${build.stderr || build.error || build.blockedBy || "unknown error"}`,
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
        return {
          success: false,
          message: `docker run failed: ${run.stderr || run.error || run.blockedBy || "unknown error"}`,
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
    branch?: string
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
    const projectName = projectNameFromInput(repoOrPath);
    const targetPath = join(resolve(this.config.paths.deployRoot), projectName);
    const hasGit = await exists(join(targetPath, ".git"));

    if (!hasGit) {
      const git = gitBinaryForRepo(repoOrPath);
      const clone = await this.shell.run({
        actor,
        channel,
        source: "slash",
        command: `${git} clone ${shellQuote(repoOrPath)} ${shellQuote(targetPath)}`,
      });
      if (clone.status !== "completed") {
        return {
          success: false,
          message: `Failed to clone repo: ${clone.stderr || clone.error || clone.blockedBy || "unknown error"}`,
        };
      }
    } else {
      const git = gitBinaryForRepo(repoOrPath);
      const pull = await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: targetPath,
        command: `${git} fetch --all --prune && ${git} checkout ${shellQuote(branch ?? "main")} && ${git} pull --ff-only`,
      });
      if (pull.status !== "completed") {
        return {
          success: false,
          message: `Failed to update repo: ${pull.stderr || pull.error || pull.blockedBy || "unknown error"}`,
        };
      }
    }

    if (branch && hasGit) {
      await this.shell.run({
        actor,
        channel,
        source: "slash",
        cwd: targetPath,
        command: `${gitBinaryForRepo(repoOrPath)} checkout ${shellQuote(branch)}`,
      });
    }

    return {
      success: true,
      message: `Prepared repository at ${targetPath}`,
      path: targetPath,
      repoUrl: repoOrPath,
    };
  }
}
