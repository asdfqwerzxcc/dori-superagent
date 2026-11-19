import { existsSync } from "node:fs";
import { shq } from "./delivery.ts";
import { RemoteError, type RemoteMachine, type RemoteRow, planRemoteStart, recordRemoteStart } from "./remotes.ts";
import type { Exec, ExecResult } from "./runtime/exec.ts";

export type RemoteRunDeps = { home: string; exec: Exec; now: () => number };
export type RemoteStartOptions = { dryRun?: boolean; out: (text: string) => void; err: (text: string) => void };

const SCP_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 300_000;

/** A command line for dry-run evidence: a display form, never executed by us. */
export const renderCommand = (cmd: string, argv: readonly string[]): string =>
  [cmd, ...argv].map((word) => (/^[A-Za-z0-9_@%+=:,./\\~-]+$/.test(word) ? word : shq(word))).join(" ");

const failure = (cmd: string, argv: readonly string[], result: ExecResult): RemoteError =>
  new RemoteError(
    `${renderCommand(cmd, argv)} failed (${result.code}): ${(
      result.stderr.trim() || result.stdout.trim() || "no output"
    ).trim()}`,
  );

/** Runs one ssh/scp call with a hard deadline: ConnectTimeout covers the handshake, this covers a hang after it. */
const bounded = async (exec: Exec, cmd: string, argv: readonly string[], ms: number): Promise<ExecResult> => {
  let kill: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      kill?.();
      reject(new RemoteError(`${cmd} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([
      exec(cmd, argv, {
        onSpawn: (proc) => {
          kill = () => proc.kill();
        },
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const startRemote = async (
  d: RemoteRunDeps,
  machine: RemoteMachine,
  key: string,
  briefFile: string,
  options: RemoteStartOptions,
): Promise<RemoteRow | undefined> => {
  const plan = planRemoteStart(machine, key, briefFile);
  if (options.dryRun === true) {
    options.out(`DRY-RUN ${machine.name} ${key} (${machine.os})\n`);
    options.out(`${renderCommand("scp", plan.scpArgv)}\n`);
    options.out(`${renderCommand("ssh", plan.sshArgv)}\n`);
    return undefined;
  }
  if (!existsSync(plan.localBrief)) throw new RemoteError(`brief not found: ${plan.localBrief}`);
  const copy = await bounded(d.exec, "scp", plan.scpArgv, SCP_TIMEOUT_MS);
  if (copy.code !== 0) throw failure("scp", plan.scpArgv, copy);
  const started = await bounded(d.exec, "ssh", plan.sshArgv, START_TIMEOUT_MS);
  if (started.code !== 0) throw failure("ssh", plan.sshArgv, started);
  options.out(started.stdout);
  options.err(started.stderr);
  const row: RemoteRow = {
    machine: machine.name,
    key,
    started_at: d.now(),
    ssh: machine.ssh,
    repo: machine.repo,
  };
  recordRemoteStart(d.home, row);
  return row;
};
