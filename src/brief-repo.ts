// A backlog brief names the checkout its work belongs to: a `repo:` line in the leading front-matter block, or one of
// the team paths a design / omo-stats brief carries. The loop starts the lane in that checkout, and a brief that names
// another team's repo is refused before the lane writes a file in the wrong tree.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** The `repo:` value of a brief's leading `---` front-matter block, unquoted; undefined when the block or key is absent. */
export function briefRepo(text: string): string | undefined {
  const block = FRONT_MATTER.exec(text)?.[1];
  if (block === undefined) return undefined;
  for (const line of block.split(/\r?\n/)) {
    const value = /^\s*repo\s*:\s*(.*?)\s*$/.exec(line)?.[1];
    if (value) return value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/** The front-matter repo hint of a brief file, resolved against the brief's own directory (absolute paths pass through).
 * An unreadable brief has no hint; startLane reports the missing file in its own words. */
export function repoHintFromBrief(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const hint = briefRepo(text);
  return hint === undefined ? undefined : resolve(dirname(file), hint);
}

/** The team checkout a brief names, with the marker that named it and the origin repo that also identifies it. */
export type BriefRepoHint = { readonly marker: string; readonly repo: string; readonly origin: string };

// Only these paths bind a brief to a repo today. `ds-v4/` is the design system's directory inside `teams/design`.
const HINTS: readonly (BriefRepoHint & { readonly re: RegExp })[] = [
  { re: /ds-v4\//, marker: "ds-v4/", repo: "teams/design", origin: "dori-design-system" },
  { re: /teams\/design(?![\w-])/, marker: "teams/design", repo: "teams/design", origin: "dori-design-system" },
  { re: /teams\/omo-stats(?![\w-])/, marker: "teams/omo-stats", repo: "teams/omo-stats", origin: "omo-stats" },
];

/** The team checkout a brief's text names, whichever marker it uses; undefined when it names none. */
export function briefRepoHint(text: string): BriefRepoHint | undefined {
  const body = text.replace(FRONT_MATTER, "").replace(/\\/g, "/").toLowerCase();
  const found = HINTS.find((hint) => hint.re.test(body));
  return found === undefined ? undefined : { marker: found.marker, repo: found.repo, origin: found.origin };
}

/** True when `checkout` is `path` itself or a directory that contains it. */
export function containsPath(checkout: string, path: string): boolean {
  const root = checkout.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return target === root || target.startsWith(`${root}/`);
}

/** The repository name in a remote URL: the last path segment without a trailing `.git`. */
const originRepo = (url: string): string | undefined =>
  url
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .pop()
    ?.toLowerCase() || undefined;

/** True when the checkout's `origin` is the team repo. The path is never the identity: a nested checkout can fake it. */
export function matchesTeamRepo(hint: BriefRepoHint, origin?: string): boolean {
  return origin !== undefined && originRepo(origin) === hint.origin;
}

/** What a starting lane knows about its checkout: the brief, its cwd, the git toplevel and the declared repo. */
export type RepoCheck = {
  readonly brief: string;
  readonly cwd: string;
  /** The git toplevel of `cwd`, or undefined when git found no repository. */
  readonly repo?: string;
  /** The `origin` remote URL of `repo`, when it has one. */
  readonly origin?: string;
  /** The checkout `--repo` or the brief's `repo:` line names, absolute. */
  readonly declared?: string;
};

/**
 * The refusal text for a lane about to start, else undefined. A declared repo must be a real git checkout containing
 * the lane's cwd; a brief that names a team repo passes only when the git toplevel's `origin` is that repo, so neither
 * a path suffix nor a hint can excuse a nested or wrong checkout. The team check runs whether or not a hint was
 * declared.
 */
export function laneRepoRefusal(check: RepoCheck): string | undefined {
  const cwd = check.cwd;
  if (check.declared !== undefined && (check.repo === undefined || !containsPath(check.repo, cwd)))
    return (
      `refusing to start: repo hint ${check.declared} is not a git checkout (git found no repository at ${cwd}); ` +
      `the lane was not started and nothing was written`
    );
  const team = briefRepoHint(check.brief);
  if (team !== undefined && !matchesTeamRepo(team, check.origin))
    return (
      `refusing to start: a brief that names ${team.marker} belongs to ${team.repo} (origin ${team.origin}), ` +
      `but this lane's checkout ${check.repo ?? cwd} has origin ${check.origin ?? "none"}\n` +
      `point --repo / the brief's "repo:" line at a checkout whose git origin is ${team.origin}, or fix that origin`
    );
  if (check.declared !== undefined && !containsPath(check.declared, cwd))
    return (
      `refusing to start: the brief declares repo ${check.declared}, but this lane would work in ${cwd}\n` +
      `start the lane in the declared checkout, or point --repo and the brief's repo: line at this one`
    );
  return undefined;
}
