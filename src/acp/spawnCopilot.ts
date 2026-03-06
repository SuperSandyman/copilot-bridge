import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { BridgeError } from "../utils/errors.js";
import type { InitializeResult, SessionNewResult } from "./types.js";

type SpawnOptions = {
  cwd: string;
  model?: string;
  agent?: string;
};

function parseExtraArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildCopilotCommand(options: SpawnOptions): {
  command: string;
  args: string[];
} {
  const command = process.env.COPILOT_BRIDGE_COMMAND ?? "copilot";
  const args = [
    "--acp",
    "--stdio",
    "--allow-all-tools",
    "--allow-all-paths",
    "--available-tools",
    "view",
    "glob",
    "grep",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.agent) {
    args.push("--agent", options.agent);
  }

  args.push(...parseExtraArgs(process.env.COPILOT_BRIDGE_EXTRA_ARGS));

  return { command, args };
}

export function spawnCopilotProcess(
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const { command, args } = buildCopilotCommand(options);

  try {
    return spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new BridgeError("COPILOT_SPAWN_FAILED", "Failed to spawn Copilot CLI", {
      command,
      args,
      cause: error,
      });
  }
}

export async function preflightSessionCreate(options: SpawnOptions): Promise<{
  initializeResult?: InitializeResult;
  sessionNewResult?: SessionNewResult;
  authRequired: boolean;
  stdoutLines: string[];
  stderrLines: string[];
}> {
  const { command, args } = buildCopilotCommand(options);
  const initializePayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "copilot-bridge", version: "1.0.0" },
      protocolVersion: 1,
    },
  });
  const sessionNewPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: {
      cwd: options.cwd,
      mcpServers: [],
    },
  });

  const child = spawn(
    "/bin/sh",
    [
      "-lc",
      `printf '%s\n%s\n' "$ACP_INIT" "$ACP_SESSION_NEW" | ${[command, ...args]
        .map(shellQuote)
        .join(" ")}`,
    ],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ACP_INIT: initializePayload,
        ACP_SESSION_NEW: sessionNewPayload,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const stdoutReader = createInterface({ input: child.stdout });
  stdoutReader.on("line", (line) => {
    if (line.trim()) {
      stdoutLines.push(line);
    }
  });

  const stderrReader = createInterface({ input: child.stderr });
  stderrReader.on("line", (line) => {
    if (line.trim()) {
      stderrLines.push(line);
    }
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });

  stdoutReader.close();
  stderrReader.close();

  let initializeResult: InitializeResult | undefined;
  let sessionNewResult: SessionNewResult | undefined;
  let authRequired = false;

  for (const line of stdoutLines) {
    try {
      const parsed = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };

      if (parsed.id === 1 && parsed.result) {
        initializeResult = parsed.result as InitializeResult;
      }

      if (parsed.id === 2 && parsed.result) {
        sessionNewResult = parsed.result as SessionNewResult;
      }

      if (parsed.id === 2 && parsed.error?.message === "Authentication required") {
        authRequired = true;
      }
    } catch {
      // Ignore non-JSON lines; stderr already captures debugging context.
    }
  }

  return {
    ...(initializeResult ? { initializeResult } : {}),
    ...(sessionNewResult ? { sessionNewResult } : {}),
    authRequired,
    stdoutLines,
    stderrLines,
  };
}
