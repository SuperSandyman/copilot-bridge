import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, openSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { BridgeError } from "../utils/errors.js";

type SpawnOptions = {
  cwd: string;
  model?: string;
  agent?: string;
};

export type SpawnedCopilotProcess = {
  child: ChildProcess;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  close: () => Promise<void>;
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

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new BridgeError("COMMAND_FAILED", `${command} exited with code ${code}`, {
          command,
          args,
          stderr,
        }),
      );
    });
  });
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

export async function spawnCopilotProcess(
  options: SpawnOptions,
): Promise<SpawnedCopilotProcess> {
  const { command, args } = buildCopilotCommand(options);
  const tempDir = await mkdtemp(join(tmpdir(), "copilot-bridge-"));
  const stdinPath = join(tempDir, "stdin.fifo");
  const stdoutPath = join(tempDir, "stdout.fifo");
  const stderrPath = join(tempDir, "stderr.fifo");

  await Promise.all([
    runCommand("mkfifo", [stdinPath]),
    runCommand("mkfifo", [stdoutPath]),
    runCommand("mkfifo", [stderrPath]),
  ]);

  const stdinFd = openSync(stdinPath, constants.O_RDWR);
  const stdin = createWriteStream(stdinPath, { fd: stdinFd, autoClose: true });
  const stdout = createReadStream(stdoutPath, { flags: "r" });
  const stderr = createReadStream(stderrPath, { flags: "r" });

  const shellCommand = `${[command, ...args].map(shellQuote).join(" ")} <${shellQuote(
    stdinPath,
  )} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`;

  const child = spawn("/bin/sh", ["-lc", shellCommand], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    await rm(tempDir, { recursive: true, force: true });
  };

  return {
    child,
    stdin,
    stdout,
    stderr,
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }

      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(resolve, 1_000).unref();
      });

      await cleanup();
    },
  };
}
