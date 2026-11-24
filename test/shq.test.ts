import { describe, expect, test } from "bun:test";
import { shq } from "../src/delivery.ts";

// POSIX only: the subject is the single-quote form a POSIX sh reads, and Windows has no sh to read it. The POSIX CI
// jobs run this test; a win32 guard here keeps the suite honest instead of failing on an absent program.
const posix = test.skipIf(process.platform === "win32");

describe("shq", () => {
  posix("a quoted word reaches a real shell unchanged, single quotes and $ included", async () => {
    for (const s of ["plain", "two words", "it's", "''", "$HOME `id` $(echo x)", "back\\slash", "new\nline", ""]) {
      const proc = Bun.spawn(["sh", "-c", `printf %s ${shq(s)}`], { windowsHide: true, stdout: "pipe" });
      expect(await new Response(proc.stdout).text()).toBe(s);
    }
  });
});
