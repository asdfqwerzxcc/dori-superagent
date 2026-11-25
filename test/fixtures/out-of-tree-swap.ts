import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchOutOfTree } from "../../src/lead-swap-detach.ts";
import { spawnExec } from "../../src/runtime/exec.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: out-of-tree-swap.ts <dir>");
const marker = join(dir, "worker-ready.txt");
const go = join(dir, "worker-go.txt");
const writer = join(import.meta.dir, "out-of-tree-writer.ts");
try {
	const launched = await launchOutOfTree(spawnExec, {
		argv: [process.execPath, writer, dir, marker],
		env: { DORI_E2E: "1" },
		cwd: process.cwd(),
		marker,
		go,
		launcherDir: dir,
	});
	writeFileSync(join(dir, "spawned.txt"), String(launched.pid));
	launched.go();
} catch (e) {
	writeFileSync(join(dir, "swap-error.txt"), e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
}
setInterval(() => { }, 1000);
