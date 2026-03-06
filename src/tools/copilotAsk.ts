import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CopilotAcpClient } from "../acp/client.js";
import { BridgeError, toErrorPayload } from "../utils/errors.js";

const CopilotAskInputSchema = {
  prompt: z.string().min(1).describe("Prompt sent to Copilot."),
  context: z
    .string()
    .optional()
    .describe("Optional extra context appended as a separate text block."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory exposed to Copilot. Defaults to the bridge cwd."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe("Per-request timeout in milliseconds. Defaults to 45000."),
  model: z.string().optional().describe("Optional Copilot model override."),
  agent: z.string().optional().describe("Optional Copilot custom agent name."),
};

const CopilotAskOutputSchema = z.object({
  text: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
  meta: z.object({
    agentName: z.string().optional(),
    agentVersion: z.string().optional(),
    sessionId: z.string().optional(),
    stopReason: z.string().optional(),
    updateTypes: z.array(z.string()),
    toolCalls: z.array(z.string()),
    stderr: z.array(z.string()),
  }),
});

export function createCopilotAskTool(server: McpServer): void {
  server.registerTool(
    "copilot_ask",
    {
      description:
        "Ask GitHub Copilot through an ACP bridge. Returns fixed text/error/meta output.",
      inputSchema: CopilotAskInputSchema,
      outputSchema: CopilotAskOutputSchema,
    },
    async (args) => {
      const client = new CopilotAcpClient({
        cwd: args.cwd ?? process.cwd(),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.agent === undefined ? {} : { agent: args.agent }),
      });

      try {
        const result = await client.ask({
          prompt: args.prompt,
          ...(args.context === undefined ? {} : { context: args.context }),
        });

        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: {
            text: result.text,
            error: null,
            meta: result.meta,
          },
        };
      } catch (error) {
        const bridgeError =
          error instanceof BridgeError
            ? error
            : new BridgeError("UNKNOWN", "Unexpected bridge failure", error);
        const payload = toErrorPayload(bridgeError);

        return {
          content: [
            {
              type: "text",
              text: `${payload.code}: ${payload.message}`,
            },
          ],
          structuredContent: {
            text: "",
            error: payload,
            meta: {
              agentName: undefined,
              agentVersion: undefined,
              sessionId: undefined,
              stopReason: undefined,
              updateTypes: [],
              toolCalls: [],
              stderr: [],
            },
          },
          isError: true,
        };
      } finally {
        await client.close();
      }
    },
  );
}
