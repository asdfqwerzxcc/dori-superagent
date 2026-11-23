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
import { done, ready, report, startLane } from "./lanes.ts";
import { runLabels } from "./labels.ts";
import { runStale } from "./stale.ts";
import { listWorktrees, pruneWorktrees } from "./worktrees.ts";
import { attest, isPrId, mergeGate, review } from "./gate.ts";
import { reviewLane } from "./lane-review.ts";
import { mergeLane } from "./lane-land.ts";
import { runDoctor } from "./doctor.ts";
import { queueLaneReview, reviewJobId } from "./review-queue.ts";
import { need, one, parse, textOf, USAGE } from "./cli-args.ts";
import { defaultDeps, ROLES, type Deps } from "./harness.ts";
import { ConfigError, hooksSettled, loadReviewSettings } from "./hooks.ts";
import { send, type SendResult } from "./inbox.ts";
import { inboxList, releaseHeld, sendToShell } from "./inbox-held.ts";
import { Refusal } from "./refusal.ts";
import { runMigrate } from "./migrate.ts";
import { refText } from "./refs.ts";
import { ConfigError as RuntimeConfigError, RuntimeChoiceError } from "./runtime/select.ts";
import { parseRef } from "./runtime/types.ts";
import { formatEnsureUp, formatSupervised } from "./supervisors.ts";
import { restartSupervisors } from "./supervisor-run.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

const COMMANDS = new Set([
  "up",
  "role",
  "start",
  "report",
  "ready",
  "send",
  "inbox",
  "duty",
  "review",
  "merge",
  "done",
  "bundle",
  "worktrees",
  "status",
  "loop",
  "backlog",
  "board",
  "sop",
  "labels",
  "stale",
  "migrate",
  "restart",
  "plugin",
  "remote",
  "agent",
  "link",
  "devices",
  "doctor",
]);

/** Prints the line for a delivery that did not land now and returns the exit code: HELD 3, everything else 0. */
function deliveryOutcome(result: SendResult | undefined, target: string): number {
  if (result === "HELD") {
    console.log(`HELD ${target}: delivery may or may not have reached the pane; do not resend`);
    return 3;
  }
  if (result === "QUEUED") console.log(`QUEUED ${target}`);
  return 0;
}

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
    case "role": {
      const role = need(x, "role") as Role;
      const given = a.pos[2];
      if (given === "-") {
        // Clearing accepts the loop roles too: a supervised home registers only lead (and duty on a pane), and an
        // older roles.json may still hold stale loop panes that no `up` will open again.
        if (!RESERVED_KEYS.includes(role)) throw new Refusal(`role must be one of ${RESERVED_KEYS.join(", ")}`);
        d.store.clearRole(role);
        console.log(`ROLE ${role}=-`);
        return 0;
      }
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const ref = given === undefined ? d.runtimes.selfAny(process.env) : parseRef(given);
      if (given !== undefined && ref === undefined)
        throw new Refusal(`${given} is not a session ref (w1:p3, herdr:w1:p3 or hc:t7)`);
      if (ref === undefined) throw new Refusal(`missing session ref (not inside herdr or hc?)\n\n${USAGE}`);
      d.store.setRole(role, ref);
      console.log(`ROLE ${role}=${refText(ref)}`);
      return 0;
    }
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
    case "review": {
      const lane = one(a, "lane");
      if (lane !== undefined) {
        if (x !== undefined) throw new Refusal("give a PR or --lane, not both");
        // With a duty loop running, the reviewer runs in its pane: the caller gets the job back and returns at once.
        const job = await queueLaneReview(d, lane, one(a, "model"));
        if (job !== undefined) {
          console.log(`QUEUED ${job.lane} ${job.tip} ${reviewJobId(job.lane, job.tip)}`);
          return 0;
        }
        const r = await reviewLane(d, lane, one(a, "model"));
        console.log(`REVIEW_LANE ${lane} tip=${r.tip} verdict=${r.verdict}`);
        return r.verdict === "CLEAR" ? 0 : 1;
      }
      const prId = need(x, "PR");
      if (a.flags.has("attest")) {
        const verdict = one(a, "verdict");
        if (verdict !== "CLEAR" && verdict !== "BLOCK") throw new Refusal("--attest needs --verdict CLEAR|BLOCK");
        const summary = one(a, "summary");
        const r = await attest(d, prId, {
          verdict,
          reviewer: need(one(a, "reviewer"), "--reviewer"),
          ...(summary === undefined ? {} : { summary }),
          evidence: a.flags.get("evidence") ?? [],
        });
        console.log(`ATTESTED ${prId} head=${r.sha} verdict=${r.verdict}`);
        return r.verdict === "CLEAR" ? 0 : 1;
      }
      const r = await review(d, prId, one(a, "model") ?? loadReviewSettings(d.store.root).model);
      console.log(`REVIEW ${prId} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
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
    case "worktrees": {
      const sub = need(x, "worktrees list|prune");
      if (sub === "list") await listWorktrees(d);
      else if (sub === "prune") await pruneWorktrees(d);
      else throw new Refusal(`unknown worktrees command ${sub}\n\n${USAGE}`);
      return 0;
    }
    case "migrate":
      return runMigrate(d, a);
    case "restart": {
      const r = await restartSupervisors(d.store.root);
      for (const line of formatSupervised(r.health)) console.log(line);
      console.log(formatEnsureUp(r.ensureUp, r.off));
      const ws = r.wsHeartbeatAgeMs === undefined ? "missing" : `${Math.round(r.wsHeartbeatAgeMs / 1000)}s`;
      console.log(`${r.ok ? "RESTARTED" : "RESTART INCOMPLETE"} killed=${r.killed.length} ms=${r.elapsedMs} ws=${ws}`);
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
