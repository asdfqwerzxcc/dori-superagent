import { copyFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { KEY_RE, reservedKey, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import type { Item } from "./store-types.ts";

export function log(d: Deps, item: Item, kind: Item["log"][number]["kind"], text: string): void {
  const now = d.now();
  item.log.push({ at: now, kind, text });
  item.updatedAt = now;
  d.store.saveItem(item);
}

export function backlogAdd(
  d: Deps,
  id: string,
  briefFile: string,
  opts: { title?: string; priority?: number; cwd?: string; decision?: string; source?: string } = {},
): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE} (it becomes the lane key)`);
  const reserved = reservedKey(id);
  if (reserved) throw new Refusal(reserved);
  const priority = opts.priority ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9)
    throw new Refusal("--priority must be 1 (first) to 9 (last)");
  if (!existsSync(briefFile)) throw new Refusal(`no brief file ${briefFile}`);
  // Checked here, not when the hourly loop starts the item hours later in a directory that was never there.
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal(`no directory ${cwd}`);
  const old = d.store.item(id);
  if (old && (old.status === "open" || old.status === "running"))
    throw new Refusal(`item ${id} is already ${old.status}`);
  copyFileSync(briefFile, d.store.itemBrief(id));
  const now = d.now();
  const item: Item = {
    id,
    title: opts.title ?? id,
    brief: d.store.itemBrief(id),
    cwd,
    priority,
    status: "open",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    log: [],
    ...(opts.decision ? { decision: opts.decision } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };
  log(d, item, "add", opts.source ?? briefFile);
  return item;
}
