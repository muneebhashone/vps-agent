export type RiskLevel = "low" | "medium" | "high";

export type RuleKind = "regex" | "token";

export interface DenyRule {
  id: string;
  pattern: string;
  kind: RuleKind;
  description?: string;
  enabled: boolean;
}

export interface PolicyConfig {
  denied: DenyRule[];
  risk: {
    highPatterns: string[];
    mediumPatterns: string[];
  };
}

export interface AppConfig {
  slack: {
    appTokenEnv: string;
    botTokenEnv: string;
  };
  openrouter: {
    apiKeyEnv: string;
  };
  opencode: {
    modelPrimary: string;
    modelFallback: string;
    defaultAgent: string;
  };
  paths: {
    dataDir: string;
    skillsDir: string;
    deployRoot: string;
  };
  projects: {
    discoveryRoots: string[];
    baseDomain: string;
    defaultHealthPath: string;
    healthTimeoutMs: number;
    defaultContainerInternalPort: number;
  };
  caddy: {
    managedSnippetPath: string;
    reloadCommand: string;
  };
  policy: {
    requireApprovalForHighRisk: boolean;
  };
}

export interface LoadedConfig {
  app: AppConfig;
  policy: PolicyConfig;
  configPath: string;
  policyPath: string;
  secretsPath: string;
}

export interface CommandRequest {
  actor: string;
  channel: string;
  source: "slash" | "mention" | "system";
  command: string;
  cwd?: string;
  bypassApproval?: boolean;
}

export interface CommandResult {
  status: "completed" | "denied" | "approval_required" | "failed";
  riskLevel: RiskLevel;
  command: string;
  blockedBy?: string;
  approvalId?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type StackType =
  | "docker-compose"
  | "dockerfile"
  | "node"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "unknown";

export interface ProjectDetection {
  stack: StackType;
  runModel: "docker-compose" | "docker" | "adapter" | "manual";
  confidence: number;
  reason: string;
}

export interface ProjectRecord {
  name: string;
  path: string;
  repoUrl?: string;
  branch?: string;
  stackType: StackType;
  runModel: string;
  domain: string;
  port?: number;
  healthPath: string;
  status: "idle" | "running" | "failed" | "unknown";
  updatedAt: string;
}

export interface DeployResult {
  success: boolean;
  message: string;
  project?: ProjectRecord;
}

export type AuditComponent =
  | "slack"
  | "deploy"
  | "shell"
  | "discovery"
  | "skills"
  | "llm"
  | "caddy"
  | "system";

export type AuditStatus = "started" | "completed" | "failed" | "info";

export interface AuditEventInput {
  eventId: string;
  component: AuditComponent;
  action: string;
  status?: AuditStatus;
  actor?: string;
  channel?: string;
  requestSource?: string;
  requestText?: string;
  meta?: unknown;
}
