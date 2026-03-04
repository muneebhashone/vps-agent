const sensitiveParamRegex = /([?&](?:token|access_token|auth|authorization)=)([^&\s]+)/gi;
const authHeaderRegex = /(authorization:\s*bearer\s+)([^\s"']+)/gi;
const httpsCredentialRegex = /(https?:\/\/)([^\/\s@]+)@/gi;

function knownSecrets(): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue;
    }
    if (!/(token|secret|password|api[_-]?key)/i.test(key)) {
      continue;
    }
    if (value.length < 8) {
      continue;
    }
    values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

export function redactSecretsInString(input: string): string {
  let output = input;
  output = output.replace(sensitiveParamRegex, "$1[REDACTED]");
  output = output.replace(authHeaderRegex, "$1[REDACTED]");
  output = output.replace(httpsCredentialRegex, "$1[REDACTED]@");

  for (const secret of knownSecrets()) {
    output = output.split(secret).join("[REDACTED]");
  }

  return output;
}

export function redactUnknown(input: unknown): unknown {
  if (typeof input === "string") {
    return redactSecretsInString(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactUnknown(item));
  }

  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).map(
      ([key, value]) => [key, redactUnknown(value)]
    );
    return Object.fromEntries(entries);
  }

  return input;
}

export function truncateText(value: string, maxLen = 4_000): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen)}...<truncated>`;
}
