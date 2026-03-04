type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const levelOrder: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export class Logger {
  constructor(private readonly minLevel: Level = "INFO") {}

  debug(message: string, meta?: unknown) {
    this.log("DEBUG", message, meta);
  }

  info(message: string, meta?: unknown) {
    this.log("INFO", message, meta);
  }

  warn(message: string, meta?: unknown) {
    this.log("WARN", message, meta);
  }

  error(message: string, meta?: unknown) {
    this.log("ERROR", message, meta);
  }

  private log(level: Level, message: string, meta?: unknown) {
    if (levelOrder[level] < levelOrder[this.minLevel]) {
      return;
    }

    const record = {
      ts: new Date().toISOString(),
      level,
      message,
      meta,
    };

    console.log(JSON.stringify(record));
  }
}
