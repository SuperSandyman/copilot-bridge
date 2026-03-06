# copilot-bridge

MCP bridge that exposes GitHub Copilot CLI as a stable external tool by speaking MCP on one side and ACP on the other.

## What it does

- Publishes one MCP tool: `copilot_ask`
- Starts `copilot --acp --stdio` for each request
- Initializes ACP, creates a fresh session, sends one prompt turn, and returns fixed `text/error/meta` output
- Surfaces authentication failures as structured errors instead of hanging on interactive terminal flows

## Tool input

`copilot_ask` accepts:

- `prompt` (required)
- `context` (optional)
- `cwd` (optional)
- `timeoutMs` (optional)
- `model` (optional)
- `agent` (optional)

## Run

```bash
npm run dev
```

Or build and run:

```bash
npm run build
node dist/server.js
```

## Notes

- The bridge uses a one-request-per-process model intentionally for the initial implementation.
- By default the spawned Copilot process is constrained to the read-oriented tools `view`, `glob`, and `grep`.
- If Copilot CLI is not authenticated yet, the tool returns `AUTH_REQUIRED` with the advertised auth methods.
