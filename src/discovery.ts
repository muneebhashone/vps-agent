import { access, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentDatabase } from "./db";
import type { Logger } from "./logger";
import type {
  AppConfig,
  ProjectDetection,
  ProjectRecord,
  StackType,
} from "./types";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSubdomain(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

async function listGitRepos(root: string, maxDepth = 5): Promise<string[]> {
  const repos: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = (await readdir(current, {
        withFileTypes: true,
      })) as Array<{ name: string; isDirectory(): boolean }>;
    } catch {
      return;
    }

    const hasGit = entries.some((entry) => entry.name === ".git");
    if (hasGit) {
      repos.push(current);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".cache"
      ) {
        continue;
      }

      await walk(join(current, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return repos;
}

async function detectStack(projectPath: string): Promise<ProjectDetection> {
  const hasCompose =
    (await pathExists(join(projectPath, "docker-compose.yml"))) ||
    (await pathExists(join(projectPath, "docker-compose.yaml"))) ||
    (await pathExists(join(projectPath, "compose.yml"))) ||
    (await pathExists(join(projectPath, "compose.yaml")));

  if (hasCompose) {
    return {
      stack: "docker-compose",
      runModel: "docker-compose",
      confidence: 1,
      reason: "docker compose manifest exists",
    };
  }

  if (await pathExists(join(projectPath, "Dockerfile"))) {
    return {
      stack: "dockerfile",
      runModel: "docker",
      confidence: 0.95,
      reason: "Dockerfile exists",
    };
  }

  if (await pathExists(join(projectPath, "package.json"))) {
    return {
      stack: "node",
      runModel: "adapter",
      confidence: 0.85,
      reason: "package.json exists",
    };
  }

  if (
    (await pathExists(join(projectPath, "pyproject.toml"))) ||
    (await pathExists(join(projectPath, "requirements.txt")))
  ) {
    return {
      stack: "python",
      runModel: "adapter",
      confidence: 0.8,
      reason: "python project markers found",
    };
  }

  if (await pathExists(join(projectPath, "go.mod"))) {
    return {
      stack: "go",
      runModel: "adapter",
      confidence: 0.8,
      reason: "go.mod exists",
    };
  }

  if (await pathExists(join(projectPath, "Cargo.toml"))) {
    return {
      stack: "rust",
      runModel: "adapter",
      confidence: 0.8,
      reason: "Cargo.toml exists",
    };
  }

  if (
    (await pathExists(join(projectPath, "pom.xml"))) ||
    (await pathExists(join(projectPath, "build.gradle"))) ||
    (await pathExists(join(projectPath, "build.gradle.kts")))
  ) {
    return {
      stack: "java",
      runModel: "adapter",
      confidence: 0.75,
      reason: "java build manifest found",
    };
  }

  return {
    stack: "unknown",
    runModel: "manual",
    confidence: 0.4,
    reason: "no known stack markers found",
  };
}

async function resolveRemoteUrl(projectPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(
      ["bash", "-lc", `git -C ${shellQuote(projectPath)} remote get-url origin`],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return undefined;
    }
    const url = stdout.trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toProjectName(projectPath: string): string {
  return sanitizeSubdomain(basename(projectPath));
}

export class ProjectDiscoveryService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AgentDatabase,
    private readonly logger: Logger
  ) {}

  async discoverAndPersist(): Promise<ProjectRecord[]> {
    const uniquePaths = new Set<string>();

    for (const root of this.config.projects.discoveryRoots) {
      const resolvedRoot = resolve(root);
      const exists = await pathExists(resolvedRoot);
      if (!exists) {
        continue;
      }
      const info = await stat(resolvedRoot);
      if (!info.isDirectory()) {
        continue;
      }

      const repos = await listGitRepos(resolvedRoot);
      for (const repoPath of repos) {
        uniquePaths.add(resolve(repoPath));
      }
    }

    const discovered: ProjectRecord[] = [];

    for (const projectPath of uniquePaths) {
      const detection = await detectStack(projectPath);
      const name = toProjectName(projectPath);
      const domain = `${name}.${this.config.projects.baseDomain}`;
      const repoUrl = await resolveRemoteUrl(projectPath);

      const project: Omit<ProjectRecord, "updatedAt"> = {
        name,
        path: projectPath,
        repoUrl,
        branch: undefined,
        stackType: detection.stack,
        runModel: detection.runModel,
        domain,
        port: undefined,
        healthPath: this.config.projects.defaultHealthPath,
        status: "unknown",
      };

      this.db.upsertProject(project);
      discovered.push({
        ...project,
        updatedAt: new Date().toISOString(),
      });
    }

    this.logger.info("Project discovery completed", {
      discoveredCount: discovered.length,
      roots: this.config.projects.discoveryRoots,
    });

    return discovered;
  }

  async detectProject(projectPath: string): Promise<ProjectDetection> {
    return detectStack(projectPath);
  }
}

export function stackLabel(stack: StackType): string {
  switch (stack) {
    case "docker-compose":
      return "docker-compose";
    case "dockerfile":
      return "dockerfile";
    case "node":
      return "node";
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
    case "java":
      return "java";
    default:
      return "unknown";
  }
}
