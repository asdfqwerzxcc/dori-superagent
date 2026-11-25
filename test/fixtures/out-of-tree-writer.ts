import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, marker] = process.argv.slice(2);
if (dir === undefined || marker === undefined) throw new Error("usage: out-of-tree-writer.ts <dir> <marker>");
writeFileSync(marker, String(process.pid));
writeFileSync(join(dir, "writer.pid"), String(process.pid));
const started = Date.now();
let done = false;
const timer = setInterval(() => {
  if (!done && Date.now() - started > 1500) {
    done = true;
    appendFileSync(join(dir, "writer-done.txt"), `pid=${process.pid} at=${Date.now()}\n`);
  }
  if (Date.now() - started > 6000) {
    clearInterval(timer);
    process.exit(0);
  }
}, 50);
