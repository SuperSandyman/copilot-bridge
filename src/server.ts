import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createCopilotAskTool } from "./tools/copilotAsk.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("server");

async function main(): Promise<void> {
  process.stdin.resume();

  const server = new McpServer({
    name: "copilot-bridge",
    version: "1.0.0",
  });

  createCopilotAskTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP bridge server started");

  const keepAlive = setInterval(() => {}, 1 << 30);
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(keepAlive);
      resolve();
    };

    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

main().catch((error) => {
  logger.error("Server startup failed", error);
  process.exitCode = 1;
});
