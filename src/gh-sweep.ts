import type { Deps } from "./harness.ts";

export const SWEEP_LIMIT = "1000";

export async function ghText(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** A repo whose issue tracker is disabled has no issues to sweep: that is a note, not a failed run. */
export async function ghList<T>(d: Deps, argv: readonly string[]): Promise<T[]> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim();
    if (argv[0] === "issue" && /disabled issues/i.test(why)) {
      console.log("NOTE issues are disabled on this repo; only pull requests are swept");
      return [];
    }
    throw new Error(`gh ${argv.join(" ")} failed: ${why}`);
  }
  const out = r.stdout.trim();
  return out === "" ? [] : (JSON.parse(out) as T[]);
}
