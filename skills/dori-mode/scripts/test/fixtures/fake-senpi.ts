#!/usr/bin/env bun
export {};

const decoder = new TextDecoder();
let buffer = "";
let active = false;

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const settle = (aborted = false): void => {
  active = false;
  send({ type: "agent_end", messages: [], willRetry: false, ...(aborted ? { aborted: true } : {}) });
  send({ type: "agent_settled" });
};

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      message = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.type === "prompt") {
      send({ type: "response", id: message.id, command: "prompt", success: true });
      active = true;
      send({ type: "agent_start" });
      if (String(message.message).includes("SLOW")) {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
      } else {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DORI" } });
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "_ACP_OK" } });
        settle();
      }
    } else if (message.type === "abort") {
      send({ type: "response", id: message.id, command: "abort", success: true });
      if (active) settle(true);
    }
  }
}
