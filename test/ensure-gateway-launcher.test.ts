import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeWithState } from "./supervisor-fixtures.ts";

test.skipIf(process.platform !== "win32")(
  "bin/ensure-gateway.ps1 runs the guard program and keeps its exit code",
  async () => {
    const home = homeWithState();
    const marker = join(home, "ran.txt");
    const guard = join(home, "fake-guard.ts");
    writeFileSync(
      guard,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ok");\nprocess.exit(3);\n`,
    );
    const ps = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "..", "bin", "ensure-gateway.ps1"),
        "-Guard",
        guard,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, DORI_HOME: home } },
    );
    const [code, stderr] = await Promise.all([ps.exited, new Response(ps.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(3);
    expect(readFileSync(marker, "utf8")).toBe("ok");
  },
);
