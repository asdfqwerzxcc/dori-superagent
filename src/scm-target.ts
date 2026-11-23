import { one, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { checkRepo, remoteOf } from "./repo-policy.ts";
import { ghScm } from "./scm-gh.ts";
import { glabScm } from "./scm-glab.ts";
import type { Scm } from "./scm.ts";

type Target =
  | { readonly kind: "gh"; readonly repo: string }
  | { readonly kind: "glab"; readonly host: string; readonly project: string };

const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;
const PROJECT = /^[\w.-]+$/;

/** A first `--repo` segment is a host only when it can be one: a dot or a port, never a bare namespace. */
const hostLike = (segment: string): boolean => HOST.test(segment) && /[.:]/.test(segment);

const checkHost = (host: string): string => {
  if (!HOST.test(host)) throw new Refusal(`--host must be a hostname, got ${JSON.stringify(host)}`);
  return host;
};

const checkProject = (project: string): string => {
  const parts = project.split("/");
  if (parts.length < 2 || parts.some((part) => !PROJECT.test(part)))
    throw new Refusal(`GitLab repo must look like group/project (subgroups allowed), got ${JSON.stringify(project)}`);
  return project;
};

const originOf = async (d: Deps): Promise<{ readonly host: string; readonly path: string } | undefined> => {
  const r = await d.exec("git", ["-C", process.cwd(), "remote", "get-url", "origin"]);
  return r.code === 0 ? remoteOf(r.stdout) : undefined;
};

const githubRepo = async (d: Deps, repo: string | undefined): Promise<string> => {
  if (repo !== undefined) {
    if (repo.split("/").length !== 2)
      throw new Refusal(`GitHub repo must look like owner/name, got ${JSON.stringify(repo)}`);
    return checkRepo(repo);
  }
  const origin = await originOf(d);
  if (origin === undefined || origin.path.split("/").length !== 2)
    throw new Refusal("give --repo owner/name (this checkout has no github origin)");
  return checkRepo(origin.path);
};

/** `--repo host/group/project`, `--host` plus `--repo group/project`, or the checkout's own GitLab origin. */
const glabTarget = async (d: Deps, repo: string | undefined, hostFlag: string | undefined): Promise<Target> => {
  let host = hostFlag;
  let project = repo;
  if (project !== undefined) {
    const parts = project.split("/");
    const prefix = parts[0]!;
    if (parts.length > 2 && hostLike(prefix)) {
      if (host !== undefined && host.toLowerCase() !== prefix.toLowerCase())
        throw new Refusal(`--host ${host} disagrees with the repo host ${prefix}`);
      host = prefix;
      project = parts.slice(1).join("/");
    }
  } else {
    const origin = await originOf(d);
    if (origin === undefined) throw new Refusal("give --repo group/project (this checkout has no origin)");
    host ??= origin.host;
    project = origin.path;
  }
  if (host === undefined) host = (await originOf(d))?.host;
  if (host === undefined || host.toLowerCase() === "github.com")
    throw new Refusal("self-managed GitLab needs --host HOST (this checkout has no GitLab origin)");
  if (project === undefined) throw new Refusal("give --repo group/project for GitLab");
  return { kind: "glab", host: checkHost(host), project: checkProject(project) };
};

const targetOf = async (d: Deps, a: Args): Promise<Target> => {
  const explicit = one(a, "scm");
  if (explicit !== undefined && explicit !== "gh" && explicit !== "glab")
    throw new Refusal(`--scm must be gh or glab (got ${JSON.stringify(explicit)})`);
  const host = one(a, "host");
  if (host !== undefined && explicit === "gh")
    throw new Refusal("--host is for --scm glab; GitHub names a repo owner/name");
  const repo = one(a, "repo");

  if (explicit === "gh") return { kind: "gh", repo: await githubRepo(d, repo) };
  if (explicit === "glab" || host !== undefined) return glabTarget(d, repo, host);
  if (repo !== undefined) {
    const parts = repo.split("/");
    return parts.length > 2 ? glabTarget(d, repo, host) : { kind: "gh", repo: checkRepo(repo) };
  }
  const origin = await originOf(d);
  if (origin === undefined) throw new Refusal("give --repo owner/name (this checkout has no origin)");
  return origin.host === "github.com"
    ? { kind: "gh", repo: checkRepo(origin.path) }
    : { kind: "glab", host: checkHost(origin.host), project: checkProject(origin.path) };
};

/**
 * `--scm` wins; otherwise --host, a host-prefixed or subgroup repo, or a non-GitHub origin selects glab.
 * A plain owner/name stays GitHub, so every pre-existing invocation resolves exactly as before.
 */
export async function resolveScm(d: Deps, a: Args): Promise<Scm> {
  const target = await targetOf(d, a);
  return target.kind === "gh" ? ghScm(d, target.repo) : glabScm(d, target.host, target.project);
}
