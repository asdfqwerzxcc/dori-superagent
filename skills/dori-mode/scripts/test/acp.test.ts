import { expect, test } from "bun:test";

import { assertLocalModel, isPidAlive, resolveSenpiCommand, SenpiBackend } from "../src/acp/backend.ts";
import { AcpError, LineFramer } from "../src/acp/protocol.ts";
import { collector, errorOf, fakeBackend, fakeChild, newSession, resultOf, response } from "./acp-test-setup.ts";

test("the line framer reassembles a split record and splits coalesced records", () => {
  const framer = new LineFramer();
  expect(framer.push('{"jsonrpc":"2.0","id":1')).toEqual([]);
  expect(framer.push(',"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"x"}\n')).toEqual([
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    '{"jsonrpc":"2.0","id":2,"method":"x"}',
  ]);
});

test("the line framer never splits a UTF-8 character across chunks", () => {
  const framer = new LineFramer();
  const bytes = new TextEncoder().encode('{"text":"한글"}\n');
  expect(framer.push(bytes.slice(0, 10))).toEqual([]);
  expect(framer.push(bytes.slice(10))).toEqual(['{"text":"한글"}']);
});

test("initialize returns the ACP v1 shape with close-session capability", async () => {
  const { messages, send } = collector(fakeBackend().backend);
  await send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "goat", version: "1" } },
  });
  const result = resultOf(messages, 1);
  expect(response(messages, 1)?.jsonrpc).toBe("2.0");
  expect(result.protocolVersion).toBe(1);
  expect(result.agentInfo).toEqual({ name: "dori-acp", title: "Dori", version: "0.1.0" });
  expect(result.agentCapabilities).toMatchObject({
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {} },
  });
  expect(result.authMethods).toEqual([]);
});

test("an unknown method returns JSON-RPC -32601", async () => {
  const { messages, send } = collector(fakeBackend().backend);
  await send({ id: 2, method: "session/load", params: { sessionId: "x" } });
  expect(errorOf(messages, 2).code).toBe(-32601);
});

test("session/prompt streams agent_message_chunk updates before the end_turn response", async () => {
  const fake = fakeBackend();
  const { messages, send } = collector(fake.backend);
  await send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const sessionId = await newSession(send, messages, 2);
  await send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } });
  const updates = messages.filter((message) => message.method === "session/update");
  expect(updates.length).toBeGreaterThanOrEqual(1);
  const params = updates[0]?.params as { readonly sessionId?: unknown; readonly update?: unknown };
  expect(params.sessionId).toBe(sessionId);
  expect(params.update).toMatchObject({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "DORI_ACP_OK" },
  });
  expect(resultOf(messages, 3).stopReason).toBe("end_turn");
  expect(messages.findIndex((message) => message.method === "session/update")).toBeLessThan(
    messages.findIndex((message) => message.id === 3),
  );
  expect(fake.state.prompts).toEqual(["hello"]);
});

test("session/cancel resolves the pending prompt with the cancelled stop reason", async () => {
  const fake = fakeBackend({ waitForCancel: true });
  const { messages, send } = collector(fake.backend);
  await send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const sessionId = await newSession(send, messages, 2);
  const pending = send({
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "slow" }] },
  });
  await fake.began;
  await send({ method: "session/cancel", params: { sessionId } });
  await pending;
  expect(resultOf(messages, 3).stopReason).toBe("cancelled");
  expect(fake.state.cancelCalls).toBe(1);
});

test("session/close closes the backend and the session cannot be prompted again", async () => {
  const fake = fakeBackend();
  const { messages, send } = collector(fake.backend);
  await send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
  const sessionId = await newSession(send, messages, 2);
  await send({ id: 3, method: "session/close", params: { sessionId } });
  expect(fake.state.closeCalls).toBe(1);
  expect(resultOf(messages, 3)).toEqual({});
  await send({ id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "again" }] } });
  expect(errorOf(messages, 4).code).toBe(-32602);
});

test("the backend loop guard refuses a GOAT or Dori provider before spawning", () => {
  expect(() => assertLocalModel("goat/default")).toThrow(AcpError);
  expect(() => assertLocalModel("dori/acp")).toThrow(AcpError);
  expect(() => assertLocalModel("opencode-go/deepseek-v4.1-flash")).not.toThrow();
});

test("the senpi command override accepts an argv array and falls back to the senpi executable", () => {
  expect(resolveSenpiCommand({})).toEqual(["senpi"]);
  expect(resolveSenpiCommand({ DORI_ACP_SENPI: '["bun","fake.ts"]' })).toEqual(["bun", "fake.ts"]);
  expect(resolveSenpiCommand({ DORI_ACP_SENPI: "C:/tools/senpi.exe" })).toEqual(["C:/tools/senpi.exe"]);
});

test("the senpi backend forwards text deltas and finishes on agent_settled", async () => {
  const backend = new SenpiBackend({
    model: "opencode-go/deepseek-v4.1-flash",
    cwd: process.cwd(),
    command: [process.execPath, fakeChild()],
    permissionPreset: false,
    log: () => undefined,
  });
  try {
    const chunks: string[] = [];
    const stop = await backend.prompt("hello", (chunk) => chunks.push(chunk));
    expect(stop).toBe("end_turn");
    expect(chunks.join("")).toBe("DORI_ACP_OK");
    expect(backend.pid).toBeNumber();
  } finally {
    const pid = backend.pid;
    await backend.close();
    if (pid) expect(isPidAlive(pid)).toBe(false);
  }
});

test("the senpi backend turns a cancel into the cancelled stop reason and kills its child", async () => {
  const backend = new SenpiBackend({
    model: "opencode-go/deepseek-v4.1-flash",
    cwd: process.cwd(),
    command: [process.execPath, fakeChild()],
    permissionPreset: false,
    log: () => undefined,
  });
  try {
    let firstChunk: (() => void) | undefined;
    const sawFirst = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const chunks: string[] = [];
    const pending = backend.prompt("SLOW", (chunk) => {
      chunks.push(chunk);
      firstChunk?.();
    });
    await sawFirst;
    await backend.cancel();
    expect(await pending).toBe("cancelled");
    expect(chunks.join("")).toBe("working");
  } finally {
    const pid = backend.pid;
    await backend.close();
    if (pid) expect(isPidAlive(pid)).toBe(false);
  }
});
