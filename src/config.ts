import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig, LoadedConfig, PolicyConfig } from "./types";

const appConfigSchema = z.object({
  slack: z.object({
    appTokenEnv: z.string().default("SLACK_APP_TOKEN"),
    botTokenEnv: z.string().default("SLACK_BOT_TOKEN"),
  }),
  openrouter: z.object({
    apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
  }),
  opencode: z.object({
    modelPrimary: z.string().default("openrouter/openai/gpt-4o-mini"),
    modelFallback: z.string().default("openrouter/openai/gpt-4o-mini"),
    defaultAgent: z.string().default("default"),
  }),
  paths: z.object({
    dataDir: z.string().default("./data"),
    skillsDir: z.string().default("./skills"),
    deployRoot: z.string().default("/srv/apps"),
  }),
  projects: z.object({
    discoveryRoots: z.array(z.string()).default(["/srv", "/opt", "/var/www"]),
    baseDomain: z.string().default("example.com"),
    defaultHealthPath: z.string().default("/health"),
    healthTimeoutMs: z.number().int().positive().default(60_000),
    defaultContainerInternalPort: z.number().int().positive().default(3000),
  }),
  caddy: z.object({
    managedSnippetPath: z
      .string()
      .default("/etc/caddy/conf.d/vps-agent-routes.caddy"),
    reloadCommand: z.string().default("systemctl reload caddy"),
  }),
  policy: z.object({
    requireApprovalForHighRisk: z.boolean().default(true),
  }),
});

const denyRuleSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  kind: z.enum(["regex", "token"]).default("regex"),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

const policySchema = z.object({
  denied: z.array(denyRuleSchema).default([]),
  risk: z.object({
    highPatterns: z.array(z.string()).default([]),
    mediumPatterns: z.array(z.string()).default([]),
  }),
});

function parseEnvFile(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx < 1) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

async function readYaml<T>(
  filePath: string,
  fallback: T,
  schema: z.ZodType<T>
): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = YAML.parse(raw) ?? fallback;
    return schema.parse(parsed);
  } catch {
    return schema.parse(fallback);
  }
}

export async function loadConfiguration(paths?: {
  configPath?: string;
  policyPath?: string;
  secretsPath?: string;
}): Promise<LoadedConfig> {
  const configPath = resolve(paths?.configPath ?? "./config/agent.yaml");
  const policyPath = resolve(paths?.policyPath ?? "./config/policy.yaml");
  const secretsPath = resolve(paths?.secretsPath ?? "./config/secrets.env");

  const defaultAppConfig = appConfigSchema.parse({});
  const app = await readYaml<AppConfig>(configPath, defaultAppConfig, appConfigSchema);
  const policy = await readYaml<PolicyConfig>(
    policyPath,
    policySchema.parse({}),
    policySchema
  );

  try {
    const secretsRaw = await readFile(secretsPath, "utf8");
    const envValues = parseEnvFile(secretsRaw);
    for (const [key, value] of Object.entries(envValues)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing secrets file; caller can validate required env vars.
  }

  await mkdir(resolve(app.paths.dataDir), { recursive: true });
  await mkdir(dirname(policyPath), { recursive: true });

  return {
    app,
    policy,
    configPath,
    policyPath,
    secretsPath,
  };
}

export async function savePolicyConfig(
  policyPath: string,
  policy: PolicyConfig
): Promise<void> {
  const parsed = policySchema.parse(policy);
  await mkdir(dirname(policyPath), { recursive: true });
  await Bun.write(policyPath, YAML.stringify(parsed));
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
