import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { briefRepo } from "./brief-repo.ts";
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
  opts: { title?: string; priority?: number; cwd?: string; repo?: string; decision?: string; source?: string } = {},
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
  // The repo hint names the checkout the work belongs to, so the loop stops falling back to the harness checkout.
  const fromFlag = opts.repo;
  const hint = fromFlag ?? briefRepo(readFileSync(briefFile, "utf8"));
  const repo =
    hint === undefined ? undefined : resolve(fromFlag === undefined ? dirname(briefFile) : process.cwd(), hint);
  if (repo !== undefined && !statSync(repo, { throwIfNoEntry: false })?.isDirectory())
    throw new Refusal(`no directory ${repo} (repo hint)`);
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
    ...(repo !== undefined ? { repo } : {}),
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
