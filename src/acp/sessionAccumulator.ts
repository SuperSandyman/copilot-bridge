import type { SessionUpdateNotification } from "./types.js";

export class SessionAccumulator {
  private readonly maxTextChars: number;
  private readonly textParts: string[] = [];
  private totalChars = 0;
  private truncated = false;
  private readonly updateTypes = new Set<string>();
  private readonly toolCalls: string[] = [];

  constructor(maxTextChars = 100_000) {
    this.maxTextChars = maxTextChars;
  }

  add(notification: SessionUpdateNotification): void {
    const update = notification.update;
    this.updateTypes.add(update.sessionUpdate);

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content?.type === "text" ? update.content.text : undefined;
      if (typeof text === "string" && text.length > 0) {
        this.appendText(text);
      }
    }

    if (update.sessionUpdate === "tool_call") {
      const title =
        typeof update.title === "string" && update.title.length > 0
          ? update.title
          : typeof update.toolCallId === "string"
            ? update.toolCallId
            : "tool_call";
      this.toolCalls.push(title);
    }
  }

  getText(): string {
    return this.textParts.join("");
  }

  getUpdateTypes(): string[] {
    return [...this.updateTypes];
  }

  getToolCalls(): string[] {
    return [...this.toolCalls];
  }

  wasTruncated(): boolean {
    return this.truncated;
  }

  private appendText(text: string): void {
    if (this.truncated) {
      return;
    }

    const remaining = this.maxTextChars - this.totalChars;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (text.length <= remaining) {
      this.textParts.push(text);
      this.totalChars += text.length;
      return;
    }

    this.textParts.push(text.slice(0, remaining));
    this.totalChars += remaining;
    this.truncated = true;
  }
}
