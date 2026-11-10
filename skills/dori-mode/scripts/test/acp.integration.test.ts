import { expect, test } from "bun:test";
import { join } from "node:path";

import { isPidAlive } from "../src/acp/backend.ts";
import { processList, startAcp, streamedText } from "./acp-harness.ts";
import { withState } from "./fakes.ts";

test("dori acp speaks ACP end to end through a spawned process and reaps its child", async () => {
  const state = withState();
  const configPath = join(state.dir, "config.json");
  await Bun.write(configPath, JSON.stringify({ defaultModel: "test/fake-model" }));
  const harness = startAcp({
    DORI_CONFIG: configPath,
    DORI_ACP_SENPI: JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/fake-senpi.ts")]),
  });
  try {
    harness.send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } });
    const initialized = await harness.waitFor((message) => message.id === 1);
    expect((initialized.result as Record<string, unknown>)["protocolVersion"]).toBe(1);

    harness.send({ id: 2, method: "session/new", params: { cwd: state.dir, mcpServers: [] } });
    const created = await harness.waitFor((message) => message.id === 2);
    const sessionId = String((created.result as Record<string, unknown>)["sessionId"]);
    expect(sessionId.startsWith("sess_")).toBe(true);

    harness.send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Reply with exactly: DORI_ACP_OK" }] } });
    const answered = await harness.waitFor((message) => message.id === 3, 20_000);
    expect((answered.result as Record<string, unknown>)["stopReason"]).toBe("end_turn");
    expect(streamedText(harness.messages)).toContain("DORI_ACP_OK");

    const stderr = await harness.waitForStderr((text) => /SENPI_CHILD pid=\d+/.test(text));
    const pidText = /SENPI_CHILD pid=(\d+)/.exec(stderr)?.[1];
    expect(typeof pidText).toBe("string");
    const pid = Number(pidText);
    expect(isPidAlive(pid)).toBe(true);

    harness.send({ id: 4, method: "session/close", params: { sessionId } });
    const closed = await harness.waitFor((message) => message.id === 4);
    expect(closed.result).toEqual({});
    await harness.close();
    expect(isPidAlive(pid)).toBe(false);
    expect((await processList(pid)).toLowerCase()).toContain("no tasks");
  } finally {
    await harness.close();
    state.done();
  }
});
