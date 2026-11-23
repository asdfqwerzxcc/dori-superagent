import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeJson } from "../src/json-file.ts";
import { clearProgress, progressPath, receiptLockPath, saveFinalReceipt } from "../src/review-progress.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

const receipt = (key: string, verdict: LaneReceipt["verdict"]): LaneReceipt => ({
  lane: key,
  verdict,
  base,
  tip,
  brief: "brief.md",
  reviewer: verdict,
  at: Date.now(),
  summary: verdict,
  chunks: [],
});

const canonical = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt | undefined =>
  d.store.laneReceipt(key, tip);

const sidecar = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt | undefined => {
  const path = progressPath(d.store.root, key, tip);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LaneReceipt;
};

const holderScript = (d: ReturnType<typeof setup>["d"], key: string): string => {
  const lockUrl = pathToFileURL(join(import.meta.dir, "..", "src", "receipt-lock.ts")).href;
  const script = join(d.store.root, `holder-${key}.ts`);
  writeFileSync(
    script,
    `import { withReceiptLock } from ${JSON.stringify(lockUrl)};
const [root, key, tip] = process.argv.slice(2);
await withReceiptLock(root, key, tip, async () => {
  process.stdout.write("LOCKED\\n");
  await new Promise(() => {});
}, { waitMs: 5_000 });
`,
  );
  return script;
};

/** Spawns a real child that acquires the lock and reports LOCKED; the parent reads the line, no sleeps. */
async function holder(d: ReturnType<typeof setup>["d"], key: string) {
  const bun = Bun.which("bun") ?? process.execPath;
  const child = Bun.spawn([bun, holderScript(d, key), d.store.root, key, tip], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  while (!out.includes("LOCKED")) {
    const { value, done } = await reader.read();
    if (done) {
      const error = await new Response(child.stderr).text();
      throw new Error(`holder exited before LOCKED: ${error}`);
    }
    out += decoder.decode(value);
  }
  return child;
}

describe("lane review lock liveness", () => {
  test("a live child owner is never preempted; after it is killed the takeover succeeds", async () => {
    const { d } = setup();
    const child = await holder(d, "live");
    const error = await saveFinalReceipt(
      { d, key: "live", tip, receipt: receipt("live", "CLEAR") },
      {
        waitMs: 200,
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("held by live pid");
    expect((error as Error).message).toContain(String(child.pid));
    expect(canonical(d, "live")).toBeUndefined();

    child.kill();
    await child.exited;
    expect(
      await saveFinalReceipt({ d, key: "live", tip, receipt: receipt("live", "CLEAR") }, { waitMs: 2_000 }),
    ).toEqual({
      where: "canonical",
    });
    expect(canonical(d, "live")?.verdict).toBe("CLEAR");
    expect(existsSync(receiptLockPath(d.store.root, "live", tip))).toBe(false);
  });

  test("probe11: a live child in the gap cannot downgrade CLEAR", async () => {
    const { d } = setup();
    expect(await saveFinalReceipt({ d, key: "probe11", tip, receipt: receipt("probe11", "CLEAR") })).toEqual({
      where: "canonical",
    });
    const child = await holder(d, "probe11");
    const error = await saveFinalReceipt(
      { d, key: "probe11", tip, receipt: receipt("probe11", "reviewer_empty") },
      { waitMs: 200 },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("held by live pid");
    expect(canonical(d, "probe11")?.verdict).toBe("CLEAR");
    child.kill();
    await child.exited;
  });

  test("probe11b: a live child in the gap cannot overwrite BLOCK", async () => {
    const { d } = setup();
    expect(await saveFinalReceipt({ d, key: "probe11b", tip, receipt: receipt("probe11b", "BLOCK") })).toEqual({
      where: "canonical",
    });
    const child = await holder(d, "probe11b");
    const error = await saveFinalReceipt(
      { d, key: "probe11b", tip, receipt: receipt("probe11b", "CLEAR") },
      { waitMs: 200 },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("held by live pid");
    expect(canonical(d, "probe11b")?.verdict).toBe("BLOCK");
    child.kill();
    await child.exited;
  });

  test("the sidecar clear is fenced by the caller's epoch", async () => {
    const { d } = setup();
    expect(await saveFinalReceipt({ d, key: "fenced-clear", tip, receipt: receipt("fenced-clear", "CLEAR") })).toEqual({
      where: "canonical",
    });
    const saved = canonical(d, "fenced-clear")!;
    const t1 = saved.writerAt!;
    expect(t1).toEqual(expect.any(Number));
    const newer = t1 + 1_000;
    writeJson(progressPath(d.store.root, "fenced-clear", tip), {
      ...receipt("fenced-clear", "reviewer_empty"),
      writerAt: newer,
    });

    await clearProgress(d, "fenced-clear", tip, t1);
    expect(sidecar(d, "fenced-clear")?.writerAt).toBe(newer);
    await clearProgress(d, "fenced-clear", tip, newer);
    expect(sidecar(d, "fenced-clear")).toBeUndefined();
  });
});
