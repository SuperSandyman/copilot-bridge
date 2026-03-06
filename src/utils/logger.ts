type LogLevel = "debug" | "info" | "error";

const enabledDebug =
  process.env.COPILOT_BRIDGE_LOG === "debug" ||
  process.env.COPILOT_BRIDGE_LOG === "1";

function write(level: LogLevel, scope: string, message: string, error?: unknown): void {
  if (level === "debug" && !enabledDebug) {
    return;
  }

  const prefix = `[copilot-bridge:${scope}:${level}]`;
  const line = `${prefix} ${message}`;
  if (error === undefined) {
    process.stderr.write(`${line}\n`);
    return;
  }

  const details =
    error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
  process.stderr.write(`${line} ${details}\n`);
}

export function createLogger(scope: string) {
  return {
    debug(message: string, error?: unknown) {
      write("debug", scope, message, error);
    },
    info(message: string, error?: unknown) {
      write("info", scope, message, error);
    },
    error(message: string, error?: unknown) {
      write("error", scope, message, error);
    },
  };
}
