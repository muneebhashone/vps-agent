import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { redactSecretsInString, redactUnknown, truncateText } from "./redaction";
import type {
  AuditEventInput,
  CommandResult,
  ProjectRecord,
  RiskLevel,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export class AgentDatabase {
  private readonly db: Database;

  constructor(path: string) {
    const dbPath = resolve(path);
    const dir = dirname(dbPath);
    this.db = new Database(dbPath, { create: true });
    void mkdir(dir, { recursive: true });
    this.bootstrap();
  }

  close() {
    this.db.close();
  }

  private bootstrap() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL UNIQUE,
        repo_url TEXT,
        branch TEXT,
        stack_type TEXT NOT NULL,
        run_model TEXT NOT NULL,
        domain TEXT NOT NULL,
        port INTEGER,
        health_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        revision TEXT,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        channel TEXT NOT NULL,
        source TEXT NOT NULL,
        command TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        blocked_by TEXT,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        channel TEXT NOT NULL,
        source TEXT NOT NULL,
        command TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        handled_by TEXT,
        handled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        component TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT,
        actor TEXT,
        channel TEXT,
        request_source TEXT,
        request_text TEXT,
        meta_json TEXT
      );
    `);
  }

  upsertProject(project: Omit<ProjectRecord, "updatedAt">) {
    const updatedAt = nowIso();
    this.db
      .query(
        `
      INSERT INTO projects (
        name, path, repo_url, branch, stack_type, run_model, domain, port, health_path, status, updated_at
      ) VALUES ($name, $path, $repoUrl, $branch, $stackType, $runModel, $domain, $port, $healthPath, $status, $updatedAt)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        repo_url = excluded.repo_url,
        branch = excluded.branch,
        stack_type = excluded.stack_type,
        run_model = excluded.run_model,
        domain = excluded.domain,
        port = excluded.port,
        health_path = excluded.health_path,
        status = excluded.status,
        updated_at = excluded.updated_at;
      `
      )
      .run({
        $name: project.name,
        $path: project.path,
        $repoUrl: project.repoUrl ?? null,
        $branch: project.branch ?? null,
        $stackType: project.stackType,
        $runModel: project.runModel,
        $domain: project.domain,
        $port: project.port ?? null,
        $healthPath: project.healthPath,
        $status: project.status,
        $updatedAt: updatedAt,
      });
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .query(
        `
      SELECT name, path, repo_url as repoUrl, branch, stack_type as stackType, run_model as runModel, domain, port, health_path as healthPath, status, updated_at as updatedAt
      FROM projects
      ORDER BY name ASC;
      `
      )
      .all() as ProjectRecord[];

    return rows;
  }

  getProject(name: string): ProjectRecord | null {
    const row = this.db
      .query(
        `
      SELECT name, path, repo_url as repoUrl, branch, stack_type as stackType, run_model as runModel, domain, port, health_path as healthPath, status, updated_at as updatedAt
      FROM projects
      WHERE name = $name
      LIMIT 1;
      `
      )
      .get({ $name: name }) as ProjectRecord | null;

    return row ?? null;
  }

  recordDeployment(
    projectName: string,
    status: "success" | "failed",
    message: string,
    revision?: string
  ) {
    this.db
      .query(
        `
      INSERT INTO deployments(project_name, revision, status, message, created_at)
      VALUES ($projectName, $revision, $status, $message, $createdAt);
      `
      )
      .run({
        $projectName: projectName,
        $revision: revision ?? null,
        $status: status,
        $message: message,
        $createdAt: nowIso(),
      });
  }

  recordCommand(
    actor: string,
    channel: string,
    source: string,
    result: CommandResult
  ) {
    const safeCommand = truncateText(redactSecretsInString(result.command), 2_000);
    const safeStdout = result.stdout
      ? truncateText(redactSecretsInString(result.stdout), 8_000)
      : null;
    const safeStderr = result.stderr
      ? truncateText(redactSecretsInString(result.stderr), 8_000)
      : null;
    const safeError = result.error
      ? truncateText(redactSecretsInString(result.error), 2_000)
      : null;

    this.db
      .query(
        `
      INSERT INTO commands(
        actor, channel, source, command, risk_level, status, blocked_by, exit_code, stdout, stderr, error, created_at
      ) VALUES (
        $actor, $channel, $source, $command, $riskLevel, $status, $blockedBy, $exitCode, $stdout, $stderr, $error, $createdAt
      );
      `
      )
      .run({
        $actor: actor,
        $channel: channel,
        $source: source,
        $command: safeCommand,
        $riskLevel: result.riskLevel,
        $status: result.status,
        $blockedBy: result.blockedBy
          ? redactSecretsInString(result.blockedBy)
          : null,
        $exitCode: result.exitCode ?? null,
        $stdout: safeStdout,
        $stderr: safeStderr,
        $error: safeError,
        $createdAt: nowIso(),
      });
  }

  recordAuditEvent(event: AuditEventInput) {
    const meta = redactUnknown(event.meta);
    this.db
      .query(
        `
      INSERT INTO audit_events(
        event_id, ts, component, action, status, actor, channel, request_source, request_text, meta_json
      ) VALUES (
        $eventId, $ts, $component, $action, $status, $actor, $channel, $requestSource, $requestText, $metaJson
      );
      `
      )
      .run({
        $eventId: event.eventId,
        $ts: nowIso(),
        $component: event.component,
        $action: event.action,
        $status: event.status ?? "info",
        $actor: event.actor ?? null,
        $channel: event.channel ?? null,
        $requestSource: event.requestSource ?? null,
        $requestText: event.requestText
          ? truncateText(redactSecretsInString(event.requestText), 4_000)
          : null,
        $metaJson: meta ? JSON.stringify(meta) : null,
      });
  }

  createApproval(input: {
    id: string;
    actor: string;
    channel: string;
    source: string;
    command: string;
    riskLevel: RiskLevel;
  }) {
    this.db
      .query(
        `
      INSERT INTO approvals(id, actor, channel, source, command, risk_level, status, requested_at)
      VALUES ($id, $actor, $channel, $source, $command, $riskLevel, 'pending', $requestedAt);
      `
      )
      .run({
        $id: input.id,
        $actor: input.actor,
        $channel: input.channel,
        $source: input.source,
        $command: input.command,
        $riskLevel: input.riskLevel,
        $requestedAt: nowIso(),
      });
  }

  getApproval(id: string): {
    id: string;
    actor: string;
    channel: string;
    source: string;
    command: string;
    riskLevel: RiskLevel;
    status: "pending" | "approved" | "rejected" | "executed";
  } | null {
    const row = this.db
      .query(
        `
      SELECT id, actor, channel, source, command, risk_level as riskLevel, status
      FROM approvals
      WHERE id = $id
      LIMIT 1;
      `
      )
      .get({ $id: id }) as
      | {
          id: string;
          actor: string;
          channel: string;
          source: string;
          command: string;
          riskLevel: RiskLevel;
          status: "pending" | "approved" | "rejected" | "executed";
        }
      | null;

    return row ?? null;
  }

  setApprovalStatus(
    id: string,
    status: "approved" | "rejected" | "executed",
    handledBy: string
  ) {
    this.db
      .query(
        `
      UPDATE approvals
      SET status = $status, handled_by = $handledBy, handled_at = $handledAt
      WHERE id = $id;
      `
      )
      .run({
        $status: status,
        $handledBy: handledBy,
        $handledAt: nowIso(),
        $id: id,
      });
  }

  listPendingApprovals(): Array<{
    id: string;
    actor: string;
    command: string;
    riskLevel: RiskLevel;
    requestedAt: string;
  }> {
    return this.db
      .query(
        `
      SELECT id, actor, command, risk_level as riskLevel, requested_at as requestedAt
      FROM approvals
      WHERE status = 'pending'
      ORDER BY requested_at ASC;
      `
      )
      .all() as Array<{
      id: string;
      actor: string;
      command: string;
      riskLevel: RiskLevel;
      requestedAt: string;
    }>;
  }
}
