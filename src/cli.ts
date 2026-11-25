#!/usr/bin/env bun
import { resolve } from "node:path";
import { runBundle } from "./bundle-cli.ts";
import { runBacklog, runDuty, runLoop } from "./cli-loops.ts";
import { runLink } from "./cli-link.ts";
import { runBoard } from "./cli-board.ts";
import { runSop } from "./cli-sop.ts";
import { pluginCommand } from "./cli-plugins.ts";
import { runRemote } from "./cli-remotes.ts";
import { status, up } from "./cli-up.ts";
import { done, pruneLaneRecords, ready, report, startLane } from "./lanes.ts";
import { leadRestart } from "./cli-lead-restart.ts";
import { runLabels } from "./labels.ts";
import { runStale } from "./stale.ts";
import { listWorktrees, pruneWorktrees } from "./worktrees.ts";
import { isPrId, mergeGate } from "./gate.ts";
import { mergeLane } from "./lane-land.ts";
import { runDoctor } from "./doctor.ts";
import { runReviewCommand } from "./review-lane-cli.ts";
import { COMMANDS, deliveryOutcome, need, one, parse, textOf, USAGE } from "./cli-args.ts";
import { runRole } from "./cli-role.ts";
import { defaultDeps, type Deps } from "./harness.ts";
import { ConfigError, hooksSettled } from "./hooks.ts";
import { send } from "./inbox.ts";
import { inboxList, releaseHeld, sendToShell } from "./inbox-held.ts";
import { Refusal } from "./refusal.ts";
import { runMigrate } from "./migrate.ts";
import { refText } from "./refs.ts";
import { ConfigError as RuntimeConfigError, RuntimeChoiceError } from "./runtime/select.ts";
import { unitMode } from "./supervisors/unit-mode.ts";
import { restartLines, restartSupervisors } from "./supervisor-restart.ts";

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  // --help is a boolean flag, so the word after it is the command: print the usage instead of running it.
  if (a.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  const [cmd, x] = a.pos;
  // doctor stays offline and writes nothing before it reports: no usage ping, no DORI_HOME creation.
  if (cmd !== undefined && COMMANDS.has(cmd) && cmd !== "doctor") d.usage.touch();
  if (cmd === "board") return runBoard(d, a, x);
  if (cmd === "sop") return runSop(d, a, x);
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()), one(a, "retire-old") === "true");
      return 0;
    case "role":
      return runRole(d, a);
    case "start": {
      const cwd = one(a, "cwd");
      const workspace = one(a, "workspace");
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(workspace !== undefined ? { group: workspace } : {}),
      });
      console.log(`STARTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`);
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      const sent = await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined);
      console.log(`REPORTED ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "ready": {
      const sent = await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "send": {
      const target = need(x, "target");
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      const sent = await deliver(d, target, await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli");
      if (sent === "DELIVERED") console.log(`DELIVERED ${target}`);
      return deliveryOutcome(sent, target);
    }
    case "inbox": {
      const target = need(a.pos[2], "target");
      if (x === "list") {
        const { paneId, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${paneId}`);
        for (const e of entries)
          console.log(`${e.index} ${e.state} from ${e.from} queued ${new Date(e.at).toISOString()} ${e.preview}`);
        return 0;
      }
      if (x === "ack" || x === "resend") {
        const index = Number(need(a.pos[3], "entry index (see dori inbox list)"));
        const paneId = releaseHeld(d, target, index, x);
        console.log(
          x === "ack" ? `ACKED ${paneId} ${index}` : `RELEASED ${paneId} ${index}: the next flush delivers it`,
        );
        return 0;
      }
      throw new Refusal(`unknown inbox command ${x}\n\n${USAGE}`);
    }
    case "duty":
      return runDuty(d, a, x);
    case "loop":
      return runLoop(d, a, x);
    case "backlog":
      return runBacklog(d, a, x);
    case "labels":
      return runLabels(d, a);
    case "stale":
      return runStale(d, a);
    case "review":
      return runReviewCommand(d, a, x);
    case "merge": {
      const bundle = one(a, "bundle");
      const lane = one(a, "lane");
      const dryRun = one(a, "dry-run") === "true";
      if (lane !== undefined && x !== undefined) throw new Refusal("give a lane key or --lane, not both");
      const target = lane ?? x;
      if (target !== undefined && !isPrId(target)) {
        if (bundle !== undefined) throw new Refusal("--bundle needs a PR id: dori merge <owner/repo#N> --bundle <id>");
        const key = target.startsWith("lane/") ? target.slice("lane/".length) : target;
        for (const line of await mergeLane(d, key, { dryRun })) console.log(line);
        return 0;
      }
      console.log(
        await mergeGate(d, need(target, "PR or lane key"), { dryRun, ...(bundle === undefined ? {} : { bundle }) }),
      );
      return 0;
    }
    case "bundle":
      return runBundle(d, a, x);
    case "done": {
      if (a.flags.has("force"))
        throw new Refusal("done no longer takes --force; use: dori done --drop <key> --reason <text>");
      const drop = one(a, "drop") === "true";
      const reason = one(a, "reason");
      const rebase = a.flags.has("rebase") || one(a, "rebase") === "true";
      if (drop && reason === undefined) throw new Refusal("done --drop needs --reason <text>");
      const note = await done(d, need(x, "lane key"), {
        ...(drop && reason !== undefined ? { drop: reason } : {}),
        ...(rebase ? { rebase: true } : {}),
      });
      console.log(`DONE ${x}${note === undefined ? "" : ` (${note})`}`);
      return 0;
    }
    case "lanes": {
      const sub = need(x, "lanes prune [--older-than N] [--dry-run]");
      if (sub !== "prune") throw new Refusal(`unknown lanes command ${sub}\n\n${USAGE}`);
      const daysArg = one(a, "older-than");
      const days = daysArg === undefined ? 7 : Number(daysArg);
      if (!Number.isFinite(days) || days < 0) throw new Refusal("--older-than must be a number of days");
      const dryRun = a.flags.has("dry-run");
      const result = pruneLaneRecords(d, days, d.now(), dryRun);
      for (const key of result.removed) console.log(`${dryRun ? "WOULD PRUNE" : "PRUNED"} ${key}`);
      console.log(
        `LANES_pruned=${result.removed.length} kept=${result.kept} kept_for_worktree=${result.skipped.length}`,
      );
      return 0;
    }
    case "worktrees": {
      const sub = need(x, "worktrees list|prune");
      if (sub === "list") await listWorktrees(d);
      else if (sub === "prune") await pruneWorktrees(d);
      else throw new Refusal(`unknown worktrees command ${sub}\n\n${USAGE}`);
      return 0;
    }
    case "migrate":
      return runMigrate(d, a);
    case "lead-restart":
      return leadRestart(d, a, x);
    case "restart": {
      const units = unitMode(d.store.root);
      const r = await restartSupervisors(d.store.root);
      for (const line of restartLines(r, units)) console.log(line);
      return r.ok ? 0 : 1;
    }
    case "status":
      await status(d);
      return 0;
    case "doctor": {
      if (x !== undefined) throw new Refusal(`doctor takes no arguments, got ${x}\n\n${USAGE}`);
      return runDoctor({ json: a.flags.has("json"), online: a.flags.has("online") });
    }
    case "plugin":
      return pluginCommand(d.store.root, x, a.pos[2]);
    case "remote":
      return runRemote(d, a, x);
    case "agent":
    case "link":
    case "devices":
      return runLink(d, a, cmd);
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" ? 0 : 64;
  }
}
if (import.meta.main) {
  const deps = defaultDeps();
  let code = 0;
  try {
    code = await main(process.argv.slice(2), deps);
  } catch (e) {
    if (
      !(
        e instanceof Refusal ||
        e instanceof ConfigError ||
        e instanceof RuntimeConfigError ||
        e instanceof RuntimeChoiceError
      )
    )
      throw e;
    console.error(e.message);
    code = 2;
  } finally {
    await hooksSettled();
    await deps.usage.flush(2000);
  }
  process.exit(code);
}
