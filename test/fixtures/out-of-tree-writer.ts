import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, marker, go, control] = process.argv.slice(2);
if (dir === undefined || marker === undefined || go === undefined || control === undefined)
	throw new Error("usage: out-of-tree-writer.ts <dir> <marker> <go> <control>");
const wait = async (path: string): Promise<void> => {
	while (!existsSync(path)) await Bun.sleep(25);
};
writeFileSync(marker, String(process.pid));
writeFileSync(join(dir, "writer.pid"), String(process.pid));
await wait(go);
writeFileSync(join(dir, "writer-go-seen.txt"), String(process.pid));
await wait(control);
appendFileSync(join(dir, "writer-done.txt"), `pid=${process.pid} at=${Date.now()}\n`);
setInterval(() => { }, 1000);
