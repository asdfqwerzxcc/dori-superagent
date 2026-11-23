import { Refusal } from "./refusal.ts";

export const USAGE = `dori - a proactive multi-session harness on herdr or hc + omo

  dori up [--cwd DIR]                         open lead, duty, duty loop and hourly loop sessions
  dori role <lead|duty> [REF|-]               register a session (w1:p3, herdr:w1:p3, hc:t7) as lead or duty (default: this one); - drops a stale role
  dori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omo session, brief + lane rules
  dori report <key> --text T [--status working|waiting]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  dori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  dori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  dori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  dori duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori duty stop [--text WHY] | resume | status   kill switch
  dori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori loop stop [--text WHY] | resume | status   kill switch and last run
  dori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  dori backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori board post --thread <id|new> [--channel C] --text T [--label L]...
  dori board reply <thread> --text T
  dori board read <thread> [--json]
  dori board tasks [--state waiting|ready|claimed|blocked|done] [--json]
  dori board task create --title T [--needs ID]... [--data K=V]...
  dori board task claim [<id>|--ready] [--lease 300] [--for W]
  dori board task renew|release|complete|fail|block <id> --token T ...
  dori board task unblock|cancel|reopen <id> ...
  dori board task needs <id> --add|--remove ID...
  dori board compact [--json]                 fold the event log into one snapshot
                                              every board command takes --json
  dori sop list | show <id> | validate <id>   SOP definitions under <home>/sops/<id>.json
  dori sop new <id> --title T [--from bundle|<id>]
                                              default template: agent -> approval -> script (the gate names bundle <id>)
  dori sop run <id> --bundle B                create a run with every node waiting
  dori sop step <run> <node> --state S [--note T]
                                              S = waiting|running|blocked|done|failed|skipped
  dori sop gate list [--json]                 runs waiting for a human decision
  dori sop gate show <run> <node> [--post] [--provider gh|glab]
                                              read-only by default; --post publishes the rationale as one MR comment
  dori sop gate approve <run> --by NAME [--note T]
  dori sop gate reject|skip <run> --by NAME --reason T
                                              approval = the one human gate: at most one per SOP, and it names its bundle
  dori sop sync <run> [--provider gh|glab] [--by NAME]
                                              read the MR reviews: approval or change request -> the same receipt as approve|reject
  dori sop rerun <run> <node>                 reset that node and everything after it
  dori labels [--repo owner/name] [--apply]   one status: label per issue/PR; fixes 0 or 2+; dry-run unless --apply
  dori stale [--repo owner/name] [--days-pr 14] [--days-comment 7] [--apply]
                                              stale PRs get a nudge then a close; stale issues get needs-info (never closed)
                                              no --repo = this checkout's github origin; writes need config/repos.json allow
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori review <owner/repo#N> --attest --verdict CLEAR|BLOCK --reviewer R --evidence E
                                             record a review done elsewhere as the receipt (no child process)
  dori review --lane <key> [--model M] [--restart]
                                              queue the lane's own diff for dori duty -> QUEUED <key> <tip> <job>;
                                              an in-flight request -> already queued <job> (<state>); --restart kills
                                              that reviewer tree first; with no duty loop, review it inline now
  dori merge <lane-key|lane/key> [--dry-run]  default gate: CLEAR lane receipt at the head -> push lane/<key> to the
                                              lane repo's own remote (fork when present, else origin) -> PR against
                                              main -> checks green (or none) -> merge commit -> delete the remote branch
  dori merge <owner/repo#N> [--dry-run]       PR form: CLEAR receipt at that head + green checks when configured -> squash merge
  dori merge <owner/repo#N> --bundle <id>     explicit bundle gate: every recorded member CLEAR at its sha + green
                                              checks when configured -> squash merge
  dori bundle open <id> --title T [--issue N] [--repo owner/name]
  dori bundle add <id> <lane-key>...          only when the lane receipt is CLEAR at the current lane/<key> head
  dori bundle list [<id>] [--json]            bundles under state/bundles/<id>.json
  dori bundle land <id> [--dry-run]           bundle/<id> from main (members merged --no-ff) + fork PR (explicit mode)
  dori bundle close <id> [--text T]           after the PR merges: verify only issue N is Closes, comment Refs
  dori bundle show <id> [--json]
  dori done <key> [--rebase]                  lead closes a READY lane; needs a CLEAR lane receipt unless it committed nothing
                                              --rebase moves the lane onto current main first, re-records its base and demands a fresh receipt
  dori done --drop <key> --reason TEXT        remove a lane's worktree and branch without landing it on main
  dori worktrees list                        every lane worktree with its status and orphan reason
  dori worktrees prune                       remove orphan worktrees and their lane/* branches (never dirty, never --force)
  dori migrate [--to hc|herdr] (--lane K | --role lead|duty|duty-loop|hourly-loop | --all) [--dry-run]
               [--wait-minutes N] [--resume]  hand sessions over to another runtime; MIGRATED, SKIP, DEFERRED,
                                              or MIGRATE_ROLLBACK (exit 3) per session
  dori restart                                restart the supervisor tree; waits for a fresh heartbeat and all five units
  dori plugin list | enable <name> | disable <name>
                                              the registry and state/plugins.json; the supervisor re-reads it every 5 s
  dori remote add <name> --ssh <user@host> [--repo PATH] [--os linux|windows]
  dori remote list
  dori remote start <name> <key> --brief FILE [--dry-run]
                                              run a lane on another LAN machine over ssh; --dry-run prints scp+ssh
  dori agent [--port 7799] [--host 0.0.0.0]   serve /pair and /status over pinned TLS to the LAN only
  dori link [--port 7799]                     print a 10-minute pairing code, the agent fingerprint and the LAN address
  dori link <host:port> [--fingerprint FP] [--code CODE] [--name NAME] [--replace]
                                              pair this machine: the fingerprint is compared by a person, then the code
  dori devices                                poll every linked device's /status: CPU, RAM, sessions, last answer
  dori devices remove <name>                  forget a linked device
  dori doctor [--json] [--online]             PASS/WARN/FAIL for this machine; --online also checks gh/glab auth
  dori status

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then dori inbox ack or dori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.`;

export type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "once",
  "force",
  "drop",
  "rebase",
  "dry-run",
  "to-shell",
  "all",
  "resume",
  "help",
  "apply",
  "replace",
  "json",
  "online",
  "ready",
  "post",
  "attest",
  "restart",
]);

export function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    // A value flag at the very end (--text $MSG with MSG unset) has no value; reading it as "true" would send that word.
    const value = BOOLEAN_FLAGS.has(name) ? "true" : argv[++i];
    if (value === undefined) throw new Refusal(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

export const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
export const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

export async function textOf(a: Args): Promise<string> {
  const given = one(a, "text");
  if (given === undefined && process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  const text = given ?? (await Bun.stdin.text()).trim();
  // An unset variable (--text "$MSG") or an empty pipe would type a blank message into the pane and print DELIVERED.
  if (!text.trim()) throw new Refusal("the message is empty: give --text or pipe the message on stdin");
  return text;
}
