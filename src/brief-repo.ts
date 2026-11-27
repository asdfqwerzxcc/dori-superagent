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

/** The team checkout a brief names, with the exact marker that named it. */
export type BriefRepoHint = { readonly marker: string; readonly repo: string };

// Only these paths bind a brief to a repo today. `ds-v4/` is the design system's directory inside `teams/design`.
const HINTS: readonly { readonly re: RegExp; readonly marker: string; readonly repo: string }[] = [
  { re: /ds-v4\//, marker: "ds-v4/", repo: "teams/design" },
  { re: /teams\/design(?![\w-])/, marker: "teams/design", repo: "teams/design" },
  { re: /teams\/omo-stats(?![\w-])/, marker: "teams/omo-stats", repo: "teams/omo-stats" },
];

/** The team checkout a brief's text names, whichever marker it uses; undefined when it names none. */
export function briefRepoHint(text: string): BriefRepoHint | undefined {
  const body = text.replace(FRONT_MATTER, "").replace(/\\/g, "/").toLowerCase();
  const found = HINTS.find((hint) => hint.re.test(body));
  return found === undefined ? undefined : { marker: found.marker, repo: found.repo };
}

/** True when `checkout` is the repo whose path ends with `suffix` (case and separator insensitive). */
export function inRepo(checkout: string, suffix: string): boolean {
  const path = checkout.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return path === suffix || path.endsWith(`/${suffix}`);
}

/** True when `checkout` is `path` itself or a directory that contains it. */
export function containsPath(checkout: string, path: string): boolean {
  const root = checkout.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return target === root || target.startsWith(`${root}/`);
}

/**
 * The refusal text when a brief names a team repo but the lane would work in another checkout, else undefined.
 * `checkout` is the repository start resolved, or the lane's cwd when the cwd is not a repository. Used only when no
 * `repo:` hint declared the checkout; a declared repo is checked by declaredRepoMismatch.
 */
export function repoMismatch(text: string, checkout: string): string | undefined {
  const hint = briefRepoHint(text);
  if (hint === undefined || inRepo(checkout, hint.repo)) return undefined;
  return (
    `refusing to start: a brief that names ${hint.marker} belongs to ${hint.repo}, but this lane would work in ${checkout}\n` +
    `add a "repo: <path-to-${hint.repo}>" line to the brief front-matter, or pass --repo <path> to dori backlog add`
  );
}

/**
 * The refusal text when a brief declares its own repo but the lane's cwd is not inside it, else undefined. The lane
 * works in its cwd, so that directory must be the declared checkout or one of its subdirectories.
 */
export function declaredRepoMismatch(declared: string, cwd: string): string | undefined {
  if (containsPath(declared, cwd)) return undefined;
  return (
    `refusing to start: the brief declares repo ${declared}, but this lane would work in ${cwd}\n` +
    `start the lane in the declared checkout, or point --repo and the brief's repo: line at this one`
  );
}
