import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, marker, go] = process.argv.slice(2);
if (dir === undefined || marker === undefined || go === undefined)
	throw new Error("usage: out-of-tree-handshake.ts <dir> <marker> <go>");
writeFileSync(marker, String(process.pid));
const deadline = Date.now() + 30_000;
while (!existsSync(go)) {
	if (Date.now() >= deadline) process.exit(2);
	await Bun.sleep(50);
}
writeFileSync(join(dir, "handshake-done.txt"), String(process.pid));
