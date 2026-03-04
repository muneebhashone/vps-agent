import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import YAML from "yaml";
import type { AppConfig, PolicyConfig } from "./types";

const defaultAppConfig: AppConfig = {
  slack: {
    appTokenEnv: "SLACK_APP_TOKEN",
    botTokenEnv: "SLACK_BOT_TOKEN",
  },
  openrouter: {
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  opencode: {
    modelPrimary: "openrouter/openai/gpt-4o-mini",
    modelFallback: "openrouter/openai/gpt-4o-mini",
    defaultAgent: "default",
  },
  paths: {
    dataDir: "./data",
    skillsDir: "./skills",
    deployRoot: "/srv/apps",
  },
  projects: {
    discoveryRoots: ["/srv", "/opt", "/var/www"],
    baseDomain: "example.com",
    defaultHealthPath: "/health",
    healthTimeoutMs: 60_000,
    defaultContainerInternalPort: 3000,
  },
  caddy: {
    managedSnippetPath: "/etc/caddy/conf.d/vps-agent-routes.caddy",
    reloadCommand: "systemctl reload caddy",
  },
  policy: {
    requireApprovalForHighRisk: true,
  },
};

const defaultPolicy: PolicyConfig = {
  denied: [
    {
      id: "rm-root",
      kind: "regex",
      pattern: "(^|\\s)rm\\s+-rf\\s+/(\\s|$)",
      description: "Prevent recursive delete of root filesystem.",
      enabled: true,
    },
    {
      id: "mkfs-block",
      kind: "regex",
      pattern: "(^|\\s)mkfs(\\.[a-z0-9]+)?\\s+",
      description: "Prevent disk formatting.",
      enabled: true,
    },
  ],
  risk: {
    highPatterns: [
      "systemctl\\s+(stop|disable|restart)",
      "caddy\\s+reload",
      "apt(-get)?\\s+(remove|purge|upgrade|dist-upgrade)",
      "ufw\\s+",
      "iptables",
    ],
    mediumPatterns: [
      "git\\s+pull",
      "git\\s+clone",
      "docker\\s+(build|run|compose)",
      "npm\\s+(install|ci)",
      "bun\\s+install",
      "pip\\s+install",
    ],
  },
};

export async function runSetupWizard(paths?: {
  configPath?: string;
  policyPath?: string;
  secretsPath?: string;
}) {
  const configPath = resolve(paths?.configPath ?? "./config/agent.yaml");
  const policyPath = resolve(paths?.policyPath ?? "./config/policy.yaml");
  const secretsPath = resolve(paths?.secretsPath ?? "./config/secrets.env");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const baseDomain =
    (await rl.question(
      `Base domain for project routing [${defaultAppConfig.projects.baseDomain}]: `
    )) || defaultAppConfig.projects.baseDomain;

  const discoveryRootsRaw =
    (await rl.question(
      `Discovery roots (comma separated) [${defaultAppConfig.projects.discoveryRoots.join(",")}]: `
    )) || defaultAppConfig.projects.discoveryRoots.join(",");

  const deployRoot =
    (await rl.question(
      `Deploy root for cloned repos [${defaultAppConfig.paths.deployRoot}]: `
    )) || defaultAppConfig.paths.deployRoot;

  const primaryModel =
    (await rl.question(
      `Primary OpenRouter model [${defaultAppConfig.opencode.modelPrimary}]: `
    )) || defaultAppConfig.opencode.modelPrimary;

  rl.close();

  const config: AppConfig = {
    ...defaultAppConfig,
    projects: {
      ...defaultAppConfig.projects,
      baseDomain: baseDomain.trim(),
      discoveryRoots: discoveryRootsRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    paths: {
      ...defaultAppConfig.paths,
      deployRoot: deployRoot.trim(),
    },
    opencode: {
      ...defaultAppConfig.opencode,
      modelPrimary: primaryModel.trim(),
      modelFallback: primaryModel.trim(),
    },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(policyPath), { recursive: true });
  await mkdir(dirname(secretsPath), { recursive: true });

  await writeFile(configPath, YAML.stringify(config), "utf8");
  await writeFile(policyPath, YAML.stringify(defaultPolicy), "utf8");

  const secretsTemplate = [
    "# Fill these values before starting the service",
    "SLACK_APP_TOKEN=",
    "SLACK_BOT_TOKEN=",
    "OPENROUTER_API_KEY=",
    "GITHUB_TOKEN=",
  ].join("\n");

  await writeFile(secretsPath, secretsTemplate, "utf8");

  console.log(`Wrote ${configPath}`);
  console.log(`Wrote ${policyPath}`);
  console.log(`Wrote ${secretsPath}`);
  console.log("Setup complete. Fill secrets and then run: bun run start");
}
