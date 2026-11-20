import { closeBundle } from "./bundle-close.ts";
import { landBundle } from "./bundle-land.ts";
import { addMembers, checkedBundle, openBundle } from "./bundles.ts";
import { one, need, type Args, USAGE } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { checkRepo, repoFromRemote } from "./repo-policy.ts";
import type { Bundle } from "./store-types.ts";

/** `fork` when the checkout has one, else `origin`; a checkout with neither names no repository. */
async function defaultRepo(d: Deps): Promise<string> {
  for (const name of ["fork", "origin"]) {
    const r = await d.exec("git", ["remote", "get-url", name]);
    if (r.code !== 0) continue;
    const repo = repoFromRemote(r.stdout);
    if (repo !== undefined) return checkRepo(repo);
  }
  throw new Refusal("give --repo owner/name (this checkout has no github fork or origin remote)");
}

function formatBundleLine(bundle: Bundle): string {
  const pr = bundle.pr === null ? "pr=-" : `pr=#${bundle.pr.number} ${bundle.pr.url}`;
  return `BUNDLE ${bundle.id} ${bundle.status} members=${bundle.members.length} branch=${bundle.branch} ${pr} ${bundle.title}`;
}

function formatBundle(bundle: Bundle): string[] {
  return [
    `BUNDLE ${bundle.id} status=${bundle.status}`,
    `title: ${bundle.title}`,
    `issue: ${bundle.issue === null ? "-" : `#${bundle.issue}`}`,
    `repo: ${bundle.repo}`,
    `branch: ${bundle.branch}`,
    `pr: ${bundle.pr === null ? "-" : `#${bundle.pr.number} ${bundle.pr.url}`}`,
    "members:",
    ...(bundle.members.length === 0
      ? ["  (none)"]
      : bundle.members.map((m) => `  lane/${m.lane} @ ${m.sha} ${m.verdict} ${m.reviewer}`)),
  ];
}

export async function runBundle(d: Deps, a: Args, sub: string | undefined): Promise<number> {
  const json = a.flags.has("json");
  if (sub === "open") {
    const id = need(a.pos[2], "bundle id");
    const title = need(one(a, "title"), "--title");
    const rawIssue = one(a, "issue");
    const issue = rawIssue === undefined ? undefined : Number(rawIssue);
    if (issue !== undefined && (!Number.isInteger(issue) || issue < 1))
      throw new Refusal("--issue must be a positive issue number");
    const repo = one(a, "repo") ?? (await defaultRepo(d));
    const bundle = openBundle(d, id, { title, repo, ...(issue === undefined ? {} : { issue }) });
    console.log(
      `BUNDLE_OPEN ${bundle.id} branch=${bundle.branch} repo=${bundle.repo}` +
        (bundle.issue === null ? "" : ` issue=#${bundle.issue}`),
    );
    return 0;
  }
  if (sub === "add") {
    const id = need(a.pos[2], "bundle id");
    const keys = a.pos.slice(3);
    if (keys.length === 0) throw new Refusal("missing lane key");
    const bundle = await addMembers(d, id, keys);
    console.log(`BUNDLE_ADD ${id} members=${bundle.members.length} added=${keys.join(",")}`);
    return 0;
  }
  if (sub === "list") {
    const id = a.pos[2];
    const bundles = id === undefined ? d.store.bundles() : [checkedBundle(d, id)];
    if (json) {
      console.log(JSON.stringify(id === undefined ? bundles : bundles[0], null, 2));
      return 0;
    }
    if (bundles.length === 0) console.log("No bundles: dori bundle open <id> --title T");
    for (const bundle of bundles) console.log(formatBundleLine(bundle));
    return 0;
  }
  if (sub === "show") {
    const bundle = checkedBundle(d, need(a.pos[2], "bundle id"));
    if (json) console.log(JSON.stringify(bundle, null, 2));
    else for (const line of formatBundle(bundle)) console.log(line);
    return 0;
  }
  if (sub === "land") {
    const id = need(a.pos[2], "bundle id");
    for (const line of await landBundle(d, id, { dryRun: a.flags.has("dry-run") })) console.log(line);
    return 0;
  }
  if (sub === "close") {
    const id = need(a.pos[2], "bundle id");
    console.log(await closeBundle(d, id, one(a, "text")));
    return 0;
  }
  throw new Refusal(`unknown bundle command ${sub ?? ""}\n\n${USAGE}`);
}
