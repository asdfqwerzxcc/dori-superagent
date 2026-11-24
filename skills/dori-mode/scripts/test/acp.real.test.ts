import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { isPidAlive } from "../src/acp/backend.ts";
import { processList, startAcp, streamedText } from "./acp-harness.ts";
import { withState } from "./fakes.ts";

const real = process.env["DORI_ACP_REAL"] === "1";
// A real model turn answers in tens of seconds; the per-event waits below still bound each step.
setDefaultTimeout(150_000);
const realModel = "opencode-go/claude-haiku-5-5";

const realConfig = async (stateDir: string): Promise<string> => {
  const path = join(stateDir, "config.json");
  await Bun.write(path, JSON.stringify({ defaultModel: realModel }));
  return path;
};

test.skipIf(!real)("a spawned dori acp answers a real model prompt with DORI_ACP_OK", async () => {
  const state = withState();
  const harness = startAcp({ DORI_CONFIG: await realConfig(state.dir), DORI_ACP_SENPI: "" });
  try {
    harness.send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "real-test", version: "1.0.0" } },
    });
    await harness.waitFor((message) => message.id === 1);
    harness.send({ id: 2, method: "session/new", params: { cwd: state.dir, mcpServers: [] } });
    const created = await harness.waitFor((message) => message.id === 2);
    const sessionId = String((created.result as Record<string, unknown>)["sessionId"]);
    harness.send({
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Reply with exactly: DORI_ACP_OK. Do not call tools." }] },
    });
    const answered = await harness.waitFor((message) => message.id === 3, 120_000);
    expect((answered.result as Record<string, unknown>)["stopReason"]).toBe("end_turn");
    expect(streamedText(harness.messages)).toContain("DORI_ACP_OK");
    const stderr = await harness.waitForStderr((text) => /SENPI_CHILD pid=\d+/.test(text));
    const pidText = /SENPI_CHILD pid=(\d+)/.exec(stderr)?.[1];
    expect(typeof pidText).toBe("string");
    const pid = Number(pidText);
    expect(isPidAlive(pid)).toBe(true);
    harness.send({ id: 4, method: "session/close", params: { sessionId } });
    await harness.waitFor((message) => message.id === 4, 20_000);
    await harness.close();
    expect(isPidAlive(pid)).toBe(false);
    // A dead pid is "no tasks" to Windows tasklist and a nonzero ps exit on POSIX.
    expect((await processList(pid)).toLowerCase()).toContain(process.platform === "win32" ? "no tasks" : "exit=1");
  } finally {
    await harness.close();
    state.done();
  }
});

test.skipIf(!real)("session/cancel stops a real model turn with the cancelled stop reason", async () => {
  const state = withState();
  const harness = startAcp({ DORI_CONFIG: await realConfig(state.dir), DORI_ACP_SENPI: "" });
  try {
    harness.send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "real-cancel-test", version: "1.0.0" },
      },
    });
    await harness.waitFor((message) => message.id === 1);
    harness.send({ id: 2, method: "session/new", params: { cwd: state.dir, mcpServers: [] } });
    const created = await harness.waitFor((message) => message.id === 2);
    const sessionId = String((created.result as Record<string, unknown>)["sessionId"]);
    harness.send({
      id: 5,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "text", text: "Write a 10,000-word essay about the history of computing. Do not call tools." },
        ],
      },
    });
    await harness.waitForStderr((text) => text.includes("SENPI_PROMPT_ACK"), 30_000);
    harness.send({ method: "session/cancel", params: { sessionId } });
    const answered = await harness.waitFor((message) => message.id === 5, 60_000);
    expect((answered.result as Record<string, unknown>)["stopReason"]).toBe("cancelled");
    harness.send({ id: 6, method: "session/close", params: { sessionId } });
    await harness.waitFor((message) => message.id === 6, 20_000);
  } finally {
    await harness.close();
    state.done();
  }
});
