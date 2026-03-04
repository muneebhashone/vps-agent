import { join, resolve } from "node:path";
import { loadConfiguration, requireEnv } from "./config";
import { AgentDatabase } from "./db";
import { DeployManager } from "./deploy";
import { ProjectDiscoveryService } from "./discovery";
import { Logger } from "./logger";
import { OpencodeReasoner } from "./llm";
import { PolicyEngine } from "./policy";
import { ShellExecutor } from "./shell";
import { SkillManager } from "./skills";
import { SlackAgent } from "./slack";
import { runSetupWizard } from "./setup";

async function main() {
  if (process.argv[2] === "setup") {
    await runSetupWizard();
    return;
  }

  const loaded = await loadConfiguration();
  const logger = new Logger("INFO");

  const openRouterKey = requireEnv(loaded.app.openrouter.apiKeyEnv);
  if (!process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = openRouterKey;
  }

  requireEnv(loaded.app.slack.appTokenEnv);
  requireEnv(loaded.app.slack.botTokenEnv);

  const dbPath = resolve(join(loaded.app.paths.dataDir, "agent.db"));
  const db = new AgentDatabase(dbPath);
  const policy = new PolicyEngine(loaded.policy, loaded.policyPath);
  const shell = new ShellExecutor(
    policy,
    db,
    logger,
    loaded.app.policy.requireApprovalForHighRisk
  );
  const discovery = new ProjectDiscoveryService(loaded.app, db, logger);
  const caddy = new (await import("./caddy")).CaddyManager(loaded.app, db, logger);
  const deploy = new DeployManager(
    loaded.app,
    db,
    shell,
    discovery,
    caddy,
    logger
  );
  const skills = new SkillManager(loaded.app, shell, logger);
  const reasoner = new OpencodeReasoner(loaded.app, logger);
  const slack = new SlackAgent(
    loaded.app,
    db,
    shell,
    policy,
    discovery,
    deploy,
    skills,
    reasoner,
    logger
  );

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down...");
    await reasoner.close();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down...");
    await reasoner.close();
    db.close();
    process.exit(0);
  });

  await discovery.discoverAndPersist();
  await slack.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  process.exit(1);
});
