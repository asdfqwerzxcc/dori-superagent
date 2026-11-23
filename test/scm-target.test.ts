import { describe, expect, test } from "bun:test";
import { parse } from "../src/cli-args.ts";
import { Refusal } from "../src/refusal.ts";
import { remoteOf, repoFromRemote } from "../src/repo-policy.ts";
import { resolveScm } from "../src/scm-target.ts";
import { World } from "./fake.ts";

const world = (origin: string | undefined): World => {
  const w = new World();
  w.git = () =>
    origin === undefined
      ? { code: 128, stdout: "", stderr: "not a git repository" }
      : { code: 0, stdout: `${origin}\n`, stderr: "" };
  return w;
};

describe("repo remote parsing", () => {
  test("scp, https, and ssh remotes name host and path", () => {
    expect(remoteOf("git@gitlab.company.local:team/sub/app.git")).toEqual({
      host: "gitlab.company.local",
      path: "team/sub/app",
    });
    expect(remoteOf("https://gitlab.company.local:8443/team/app.git")).toEqual({
      host: "gitlab.company.local:8443",
      path: "team/app",
    });
    expect(remoteOf("ssh://git@gitlab.company.local:2222/team/app.git")).toEqual({
      host: "gitlab.company.local",
      path: "team/app",
    });
    expect(remoteOf("not a remote")).toBeUndefined();
  });

  test("repoFromRemote keeps the github-only answer every caller already relies on", () => {
    expect(repoFromRemote("git@github.com:asdfqwerzxcc/dori-superagent.git")).toBe("asdfqwerzxcc/dori-superagent");
    expect(repoFromRemote("https://github.com/asdfqwerzxcc/dori-superagent")).toBe("asdfqwerzxcc/dori-superagent");
    expect(repoFromRemote("https://gitlab.com/a/b.git")).toBeUndefined();
  });
});

describe("SCM target resolution", () => {
  test("a github origin stays GitHub", async () => {
    const scm = await resolveScm(
      world("https://github.com/asdfqwerzxcc/dori-superagent.git").deps(),
      parse(["labels"]),
    );
    expect(scm.kind).toBe("gh");
    expect(scm.repo).toBe("asdfqwerzxcc/dori-superagent");
  });

  test("a GitLab origin selects glab with a host/path identity", async () => {
    const scm = await resolveScm(world("git@gitlab.company.local:team/sub/app.git").deps(), parse(["stale"]));
    expect(scm.kind).toBe("glab");
    expect(scm.repo).toBe("gitlab.company.local/team/sub/app");
  });

  test("a plain owner/name stays GitHub, so existing invocations do not change", async () => {
    const scm = await resolveScm(
      world("git@gitlab.company.local:team/app.git").deps(),
      parse(["labels", "--repo", "acme/app"]),
    );
    expect(scm.kind).toBe("gh");
    expect(scm.repo).toBe("acme/app");
  });

  test("--scm glab with --host works for a two-segment project", async () => {
    const scm = await resolveScm(
      world(undefined).deps(),
      parse(["labels", "--scm", "glab", "--repo", "team/app", "--host", "gitlab.company.local"]),
    );
    expect(scm.kind).toBe("glab");
    expect(scm.repo).toBe("gitlab.company.local/team/app");
  });

  test("a host-prefixed repo names the host without another flag", async () => {
    const scm = await resolveScm(world(undefined).deps(), parse(["stale", "--repo", "gitlab.company.local/team/app"]));
    expect(scm.kind).toBe("glab");
    expect(scm.repo).toBe("gitlab.company.local/team/app");
  });

  test("a subgroup repo borrows the checkout's GitLab origin host", async () => {
    const scm = await resolveScm(
      world("git@gitlab.company.local:other/repo.git").deps(),
      parse(["labels", "--repo", "team/sub/app"]),
    );
    expect(scm.kind).toBe("glab");
    expect(scm.repo).toBe("gitlab.company.local/team/sub/app");
  });

  test("--scm gh still reads a non-github origin as owner/repo", async () => {
    const scm = await resolveScm(
      world("https://ghe.company.local/teams/app.git").deps(),
      parse(["labels", "--scm", "gh"]),
    );
    expect(scm.kind).toBe("gh");
    expect(scm.repo).toBe("teams/app");
  });

  test("a bad --scm or a gh run with --host is refused", async () => {
    await expect(resolveScm(world(undefined).deps(), parse(["labels", "--scm", "svn"]))).rejects.toThrow(Refusal);
    await expect(
      resolveScm(world(undefined).deps(), parse(["labels", "--scm", "gh", "--host", "gitlab.local"])),
    ).rejects.toThrow(Refusal);
  });

  test("glab with no host and no GitLab origin is refused, not guessed", async () => {
    await expect(
      resolveScm(world(undefined).deps(), parse(["labels", "--scm", "glab", "--repo", "team/app"])),
    ).rejects.toThrow(Refusal);
    await expect(
      resolveScm(world("git@github.com:acme/app.git").deps(), parse(["labels", "--scm", "glab", "--repo", "team/app"])),
    ).rejects.toThrow(Refusal);
  });
});
