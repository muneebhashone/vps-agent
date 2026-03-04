import { randomUUID } from "node:crypto";
import { savePolicyConfig } from "./config";
import type { PolicyConfig, RiskLevel } from "./types";

const builtInDeniedRegex: Array<{ id: string; pattern: RegExp; description: string }> =
  [
    {
      id: "builtin-rm-root",
      pattern: /(^|\s)rm\s+-rf\s+\/(\s|$)/i,
      description: "Blocks destructive deletion of root filesystem.",
    },
    {
      id: "builtin-dd-disk",
      pattern: /(^|\s)dd\s+.*of=\/dev\/(sd|nvme|vd|xvd)[a-z0-9]+/i,
      description: "Blocks raw disk overwrite operations.",
    },
    {
      id: "builtin-mkfs",
      pattern: /(^|\s)mkfs(\.[a-z0-9]+)?\s+/i,
      description: "Blocks filesystem format commands.",
    },
  ];

function tokenize(command: string): string[] {
  const tokens = command.match(/[^\s"']+|"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g) ?? [];
  return tokens.map((token) => token.toLowerCase());
}

function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || tokens.length < sequence.length) {
    return false;
  }

  for (let i = 0; i <= tokens.length - sequence.length; i += 1) {
    let ok = true;
    for (let j = 0; j < sequence.length; j += 1) {
      if (tokens[i + j] !== sequence[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return true;
    }
  }

  return false;
}

export class PolicyEngine {
  private policy: PolicyConfig;

  constructor(policy: PolicyConfig, private readonly policyPath: string) {
    this.policy = policy;
  }

  listRules() {
    return this.policy.denied;
  }

  async addRule(input: {
    pattern: string;
    kind?: "regex" | "token";
    description?: string;
  }) {
    this.policy.denied.push({
      id: `rule-${randomUUID().slice(0, 8)}`,
      pattern: input.pattern,
      kind: input.kind ?? "regex",
      description: input.description,
      enabled: true,
    });
    await savePolicyConfig(this.policyPath, this.policy);
  }

  async removeRule(id: string): Promise<boolean> {
    const before = this.policy.denied.length;
    this.policy.denied = this.policy.denied.filter((rule) => rule.id !== id);
    if (this.policy.denied.length === before) {
      return false;
    }
    await savePolicyConfig(this.policyPath, this.policy);
    return true;
  }

  classifyRisk(command: string): RiskLevel {
    const normalized = command.toLowerCase();

    for (const pattern of this.policy.risk.highPatterns) {
      if (new RegExp(pattern, "i").test(normalized)) {
        return "high";
      }
    }

    for (const pattern of this.policy.risk.mediumPatterns) {
      if (new RegExp(pattern, "i").test(normalized)) {
        return "medium";
      }
    }

    const highFallback =
      /(systemctl\s+(stop|disable|restart)|ufw\s+|iptables|apt(-get)?\s+(remove|purge|upgrade|dist-upgrade)|dnf\s+upgrade|yum\s+update|caddy\s+reload|service\s+\w+\s+(stop|restart))/i;
    if (highFallback.test(normalized)) {
      return "high";
    }

    const mediumFallback =
      /\b(git\s+pull|git\s+clone|npm\s+(install|ci)|pnpm\s+install|bun\s+install|pip\s+install|go\s+build|cargo\s+build|docker\s+(build|run|compose))/i;
    if (mediumFallback.test(normalized)) {
      return "medium";
    }

    return "low";
  }

  evaluate(command: string): {
    allowed: boolean;
    blockedBy?: string;
    riskLevel: RiskLevel;
  } {
    const normalized = command.trim();
    const lower = normalized.toLowerCase();
    const tokens = tokenize(lower);

    for (const builtIn of builtInDeniedRegex) {
      if (builtIn.pattern.test(lower)) {
        return {
          allowed: false,
          blockedBy: `${builtIn.id}: ${builtIn.description}`,
          riskLevel: "high",
        };
      }
    }

    for (const rule of this.policy.denied) {
      if (!rule.enabled) {
        continue;
      }

      if (rule.kind === "regex") {
        const regex = new RegExp(rule.pattern, "i");
        if (regex.test(lower)) {
          return {
            allowed: false,
            blockedBy: `${rule.id}${rule.description ? `: ${rule.description}` : ""}`,
            riskLevel: this.classifyRisk(command),
          };
        }
        continue;
      }

      const sequence = rule.pattern
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (containsTokenSequence(tokens, sequence)) {
        return {
          allowed: false,
          blockedBy: `${rule.id}${rule.description ? `: ${rule.description}` : ""}`,
          riskLevel: this.classifyRisk(command),
        };
      }
    }

    return { allowed: true, riskLevel: this.classifyRisk(command) };
  }
}
