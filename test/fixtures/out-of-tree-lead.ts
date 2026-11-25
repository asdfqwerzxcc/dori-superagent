import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: out-of-tree-lead.ts <dir>");
const swap = Bun.spawn([process.execPath, join(import.meta.dir, "out-of-tree-swap.ts"), dir], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  windowsHide: true,
});
writeFileSync(join(dir, "lead.pid"), String(process.pid));
writeFileSync(join(dir, "lead.swap.pid"), String(swap.pid ?? 0));
setInterval(() => {}, 1000);
