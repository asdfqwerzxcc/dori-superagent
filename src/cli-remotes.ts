import { type Args, need, one, USAGE } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { startRemote } from "./remote-run.ts";
import {
  addRemoteMachine,
  findRemoteMachine,
  readRemoteConfig,
  readRemoteState,
  writeRemoteConfig,
} from "./remotes.ts";

/** `dori remote add|list|start`: other machines on the same LAN over plain ssh. */
export async function runRemote(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const home = d.store.root;
  const name = a.pos[2];
  if (sub === "add") {
    const repo = one(a, "repo");
    const os = one(a, "os");
    const temp = one(a, "temp");
    const config = addRemoteMachine(readRemoteConfig(home), {
      name: need(name, "machine name"),
      ssh: need(one(a, "ssh"), "--ssh <user@host>"),
      ...(repo === undefined ? {} : { repo }),
      ...(os === undefined ? {} : { os }),
      ...(temp === undefined ? {} : { temp }),
    });
    writeRemoteConfig(home, config);
    const added = config.machines.at(-1)!;
    console.log(`REMOTE ${added.name} ssh=${added.ssh} repo=${added.repo} os=${added.os} temp=${added.temp}`);
    return 0;
  }
  if (sub === "list") {
    const config = readRemoteConfig(home);
    if (config.machines.length === 0) console.log("No remote machines: dori remote add <name> --ssh <user@host>");
    for (const m of config.machines) console.log(`${m.name} ${m.ssh} ${m.repo} ${m.os}`);
    for (const r of readRemoteState(home).rows.slice(-10))
      console.log(`START ${r.machine} ${r.key} ${new Date(r.started_at).toISOString()}`);
    return 0;
  }
  if (sub === "start") {
    const machine = findRemoteMachine(readRemoteConfig(home), need(name, "machine name"));
    const key = need(a.pos[3], "lane key");
    const brief = need(one(a, "brief"), "--brief FILE");
    const row = await startRemote({ home, exec: d.exec, now: d.now }, machine, key, brief, {
      dryRun: a.flags.has("dry-run"),
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
    if (row !== undefined)
      console.log(`REMOTE_STARTED ${row.machine} ${row.key} ${new Date(row.started_at).toISOString()}`);
    return 0;
  }
  throw new Refusal(`unknown remote command ${sub ?? ""}\n\n${USAGE}`);
}
