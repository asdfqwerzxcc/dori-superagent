// The local merge guard: landing a lane by fast-forwarding local `main` leaves commits that never passed a PR. doctor
// names them so the next landing uses `dori merge <lane-key>`, where the receipt and the PR are the only way in. The
// comparison uses the main line's own remote: `fork/main` when it exists, else `origin/main`.

import type { DoctorEnv } from "./doctor-env.ts";
import type { ProbeResult } from "./doctor.ts";
import { clip, firstLine } from "./doctor-util.ts";

const LOCAL = "refs/heads/main";
const REMOTES = ["refs/remotes/fork/main", "refs/remotes/origin/main"] as const;

export const mergeGuardCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const inside = await e.run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: e.cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== "true")
    return { status: "PASS", detail: "not a git checkout: no local main to compare" };
  const [local, ...remotes] = await Promise.all([
    e.run(["git", "rev-parse", "--verify", "--quiet", LOCAL], { cwd: e.cwd }),
    ...REMOTES.map((ref) => e.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: e.cwd })),
  ]);
  if (local.code !== 0) return { status: "PASS", detail: "no local main branch; nothing to compare" };
  const remoteIndex = remotes.findIndex((ref) => ref.code === 0);
  if (remoteIndex < 0)
    return { status: "PASS", detail: "neither fork/main nor origin/main is fetched; local main not compared" };
  const remoteRef = REMOTES[remoteIndex]!;
  const ahead = await e.run(["git", "rev-list", "--count", `${remoteRef}..${LOCAL}`], { cwd: e.cwd });
  if (ahead.code !== 0)
    return {
      status: "WARN",
      detail: `cannot compare main with ${remoteRef}: ${clip(firstLine(ahead.stderr || ahead.stdout), 90)}`,
      hint: "fetch the main line, then rerun dori doctor",
    };
  const count = Number(ahead.stdout.trim());
  if (!Number.isInteger(count) || count < 0)
    return {
      status: "WARN",
      detail: `cannot read how far main is ahead of ${remoteRef}: ${clip(ahead.stdout.trim(), 60)}`,
      hint: "fetch the main line, then rerun dori doctor",
    };
  if (count === 0) return { status: "PASS", detail: "main matches its remote" };
  const log = await e.run(["git", "log", "--format=%h %s", "-n", "5", `${remoteRef}..${LOCAL}`], { cwd: e.cwd });
  const commits =
    log.code === 0
      ? log.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "")
      : [];
  return {
    status: "WARN",
    detail: `main has ${count} commit(s) not landed through a PR${commits.length === 0 ? "" : `: ${commits.join("; ")}`}`,
    hint: "land lanes with dori merge <lane-key>; do not fast-forward main locally",
  };
};
