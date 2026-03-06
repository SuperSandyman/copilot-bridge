import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { preflightSessionCreate, spawnCopilotProcess } from "./spawnCopilot.js";
import { SessionAccumulator } from "./sessionAccumulator.js";
import type {
  CopilotAskRequest,
  CopilotAskResult,
  InitializeResult,
  JsonRpcId,
  JsonRpcIncoming,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionNewResult,
  SessionPromptResult,
  SessionUpdateNotification,
} from "./types.js";
import { BridgeError, isJsonRpcErrorLike } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
};

type CopilotAcpClientOptions = {
  cwd: string;
  timeoutMs?: number;
  model?: string;
  agent?: string;
};

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_PROMPT_CHARS = 32_000;

export class CopilotAcpClient {
  private readonly options: CopilotAcpClientOptions;
  private readonly logger = createLogger("acp");
  private readonly timeoutMs: number;
  private readonly maxPromptChars: number;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutReader?: ReturnType<typeof createInterface>;
  private stderrReader?: ReturnType<typeof createInterface>;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly stderrLines: string[] = [];
  private initialized = false;
  private initializeResult?: InitializeResult;
  private currentSessionId?: string;
  private accumulator?: SessionAccumulator;
  private closed = false;

  constructor(options: CopilotAcpClientOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptChars = Number.parseInt(
      process.env.COPILOT_BRIDGE_MAX_PROMPT_CHARS ?? `${DEFAULT_MAX_PROMPT_CHARS}`,
      10,
    );
  }

  async ask(request: CopilotAskRequest): Promise<CopilotAskResult> {
    const blocks = this.buildPromptBlocks(request);
    const preflight = await preflightSessionCreate(this.options);

    if (preflight.initializeResult) {
      this.initializeResult = preflight.initializeResult;
    }

    if (preflight.authRequired) {
      throw new BridgeError("AUTH_REQUIRED", "Copilot CLI requires authentication", {
        authMethods: this.initializeResult?.authMethods ?? [],
        stderr: preflight.stderrLines,
      });
    }

    await this.connect();
    await this.initialize();

    let session: SessionNewResult;
    try {
      session = await this.request<SessionNewResult>("session/new", {
        cwd: this.options.cwd,
        mcpServers: [],
      });
    } catch (error) {
      if (isJsonRpcErrorLike(error) && error.message === "Authentication required") {
        throw new BridgeError("AUTH_REQUIRED", "Copilot CLI requires authentication", {
          authMethods: this.initializeResult?.authMethods ?? [],
          stderr: this.stderrLines,
        });
      }

      throw this.wrapError("SESSION_CREATE_FAILED", "Failed to create ACP session", error);
    }

    this.currentSessionId = session.sessionId;
    this.accumulator = new SessionAccumulator();

    let promptResult: SessionPromptResult;
    try {
      promptResult = await this.request<SessionPromptResult>(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: blocks,
        },
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof BridgeError && error.code === "TIMEOUT") {
        this.notify("session/cancel", { sessionId: session.sessionId });
        throw error;
      }

      throw this.wrapError("PROMPT_FAILED", "Copilot prompt turn failed", error);
    }

    const text = this.accumulator.getText().trim();
    const updateTypes = this.accumulator.getUpdateTypes();
    const toolCalls = this.accumulator.getToolCalls();

    return {
      text,
      meta: {
        ...(this.initializeResult?.agentInfo?.name
          ? { agentName: this.initializeResult.agentInfo.name }
          : {}),
        ...(this.initializeResult?.agentInfo?.version
          ? { agentVersion: this.initializeResult.agentInfo.version }
          : {}),
        sessionId: session.sessionId,
        stopReason: promptResult.stopReason,
        updateTypes,
        toolCalls,
        stderr: [...this.stderrLines],
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new BridgeError("PROCESS_CLOSED", "ACP connection closed before completion", {
          id,
          stderr: this.stderrLines,
        }),
      );
    }
    this.pending.clear();

    this.stdoutReader?.close();
    this.stderrReader?.close();

    if (!this.process) {
      return;
    }

    this.process.stdin.end();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process?.kill("SIGTERM");
        resolve();
      }, 1_000);

      this.process?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawnCopilotProcess(this.options);

    this.process.on("error", (error) => {
      const wrapped =
        error && typeof error === "object" && "code" in error && error.code === "ENOENT"
          ? new BridgeError("COPILOT_NOT_FOUND", "Copilot CLI was not found on PATH", error)
          : this.wrapError("COPILOT_PROCESS_ERROR", "Copilot process failed", error);
      this.failAllPending(wrapped);
    });

    this.process.on("close", (code, signal) => {
      const error = new BridgeError(
        "COPILOT_PROCESS_EXITED",
        "Copilot process exited before the request completed",
        {
          code,
          signal,
          stderr: this.stderrLines,
        },
      );

      setTimeout(() => {
        this.failAllPending(error);
      }, 0).unref();
    });

    this.stdoutReader = createInterface({ input: this.process.stdout });
    this.stdoutReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      this.logger.debug("stdout", line);
      this.handleIncoming(line);
    });

    this.stderrReader = createInterface({ input: this.process.stderr });
    this.stderrReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      this.stderrLines.push(line);
      if (this.stderrLines.length > 20) {
        this.stderrLines.shift();
      }
      this.logger.debug("stderr", line);
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.process) {
        reject(new BridgeError("COPILOT_SPAWN_FAILED", "Copilot process was not created"));
        return;
      }

      if (this.process.pid) {
        resolve();
        return;
      }

      this.process.once("spawn", () => resolve());
      this.process.once("error", reject);
    });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      this.initializeResult = await this.request<InitializeResult>("initialize", {
        protocolVersion: 1,
        clientInfo: {
          name: "copilot-bridge",
          version: "1.0.0",
        },
      });
      this.initialized = true;
    } catch (error) {
      throw this.wrapError("INITIALIZE_FAILED", "ACP initialization failed", error);
    }
  }

  private request<T>(
    method: string,
    params?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.process) {
      throw new BridgeError("NOT_CONNECTED", "ACP request attempted before connection");
    }

    const id = this.nextRequestId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError("TIMEOUT", `ACP request timed out: ${method}`, {
            method,
            timeoutMs,
            sessionId: this.currentSessionId,
            stderr: this.stderrLines,
          }),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      this.write(message);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private write(message: object): void {
    if (!this.process?.stdin.writable) {
      throw new BridgeError("PROCESS_STDIN_CLOSED", "Cannot write to Copilot process");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleIncoming(line: string): void {
    let message: JsonRpcIncoming;

    try {
      message = JSON.parse(line) as JsonRpcIncoming;
    } catch (error) {
      this.failAllPending(
        new BridgeError("INVALID_JSON", "Received invalid JSON from Copilot", {
          line,
          cause: error,
        }),
      );
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if ("id" in message && "method" in message) {
      this.handleServerRequest(message as JsonRpcRequest);
      return;
    }

    this.handleNotification(message as JsonRpcNotification);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if ("error" in response) {
      pending.reject(response.error);
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (
      notification.method === "session/update" &&
      this.accumulator &&
      notification.params &&
      typeof notification.params === "object"
    ) {
      this.accumulator.add(notification.params as SessionUpdateNotification);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const error = {
      jsonrpc: "2.0" as const,
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported ACP client method: ${request.method}`,
      },
    };
    this.write(error);
  }

  private failAllPending(error: BridgeError): void {
    if (this.pending.size === 0) {
      return;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private buildPromptBlocks(request: CopilotAskRequest): Array<{ type: "text"; text: string }> {
    const blocks = [{ type: "text" as const, text: request.prompt.trim() }];

    if (request.context?.trim()) {
      blocks.push({
        type: "text",
        text: `Context:\n${request.context.trim()}`,
      });
    }

    const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (totalChars > this.maxPromptChars) {
      throw new BridgeError("PROMPT_TOO_LARGE", "Prompt exceeds configured size limit", {
        totalChars,
        maxPromptChars: this.maxPromptChars,
      });
    }

    return blocks;
  }

  private wrapError(code: string, message: string, error: unknown): BridgeError {
    if (error instanceof BridgeError) {
      return error;
    }

    if (isJsonRpcErrorLike(error)) {
      return new BridgeError(code, `${message}: ${error.message}`, {
        rpcCode: error.code,
        rpcData: error.data,
        stderr: this.stderrLines,
      });
    }

    return new BridgeError(code, message, {
      cause: error,
      stderr: this.stderrLines,
    });
  }
}
