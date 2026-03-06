import test from "node:test";
import assert from "node:assert/strict";

import { SessionAccumulator } from "./sessionAccumulator.js";

test("SessionAccumulator concatenates agent message chunks", () => {
  const accumulator = new SessionAccumulator();

  accumulator.add({
    sessionId: "sess_1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello " },
    },
  });

  accumulator.add({
    sessionId: "sess_1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    },
  });

  assert.equal(accumulator.getText(), "hello world");
  assert.deepEqual(accumulator.getUpdateTypes(), ["agent_message_chunk"]);
});

test("SessionAccumulator tracks tool calls and truncation", () => {
  const accumulator = new SessionAccumulator(5);

  accumulator.add({
    sessionId: "sess_1",
    update: {
      sessionUpdate: "tool_call",
      title: "Inspecting repository",
      toolCallId: "call_1",
    },
  });

  accumulator.add({
    sessionId: "sess_1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "abcdef" },
    },
  });

  assert.equal(accumulator.getText(), "abcde");
  assert.equal(accumulator.wasTruncated(), true);
  assert.deepEqual(accumulator.getToolCalls(), ["Inspecting repository"]);
});
