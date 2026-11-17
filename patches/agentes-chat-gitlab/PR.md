# GitLab: a self-hosted connection that clones and pushes through the git proxy

- Status: Draft (upstream PR description; not opened)
- Date: 2026-11-17
- Extends ADR 0024 (git proxy), sections "Endpoint", "Policy", "Upstream credential" and "Tools".
- Patch series: `0001-gitlab-connection.patch`, `0002-gitlab-proxy.patch`
- Files: `apps/server/src/routes/app/connectors.ts`, `packages/engine/src/connectors/catalog.ts`,
  `packages/engine/src/connectors/connections.ts`, `packages/engine/src/connectors/listing.ts`,
  `packages/engine/src/connectors/mcp.ts`,
  `packages/engine/src/git/gitlab.ts`, `packages/engine/src/git/machine.ts`,
  `packages/engine/src/git/proxy.ts`, `packages/engine/src/git/tools.ts`,
  `packages/engine/src/index.ts`, `packages/engine/src/tools/gateway.ts`,
  `packages/engine/test/connectors.test.ts`, `packages/engine/test/git.test.ts`,
  `packages/engine/test/git-machine.test.ts`

## Context

ADR 0024 made the agent's computer talk smart-HTTP git to `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/…`
and the server forward to the host with the organization's token. v0.1.2 still names one host in code:
`packages/engine/src/git/proxy.ts:317` falls back to
`{ gitUrl: "https://github.com", apiUrl: "https://api.github.com" }`, the policy scopes are the constants
`github:git.read` / `github:git.write` (`proxy.ts:34-37`), `packages/engine/src/git/credential.ts` issues
only our own `agtgit1` HMAC (which is right), and `apps/server/src/routes/git.ts` already routes by
`connectionId`. A self-hosted GitLab has a different base URL, a different REST prefix (`/api/v4`) and a
different header (`PRIVATE-TOKEN`, or HTTP Basic with `oauth2:<token>`), so the constants cannot serve it.

## Decision

1. **A connection type, not a second proxy.** `CONNECTOR_CATALOG` gains `gitlab`
   (`category: "dev"`, `selfHosted: true`, `mcp: false`, `listed: false`, `auth: ["api_key"]`) with
   `git.read` and `git.write`, mirroring GitHub's git scopes in GitLab's words. `createApiKeyConnection` accepts a
   `serverUrl` for a `selfHosted` connector (required; https, or http on localhost; no query, fragment or
   credentials in it) and rejects it for every other connector. The base URL lives in
   `connector_connections.server_url`; the token is sealed in the existing envelope-encrypted secret
   columns with the connection's AAD, exactly like GitHub's key. No new table, column, migration or env
   var. `connectionView` is unchanged and carries no secret, so the token never reaches a client.
2. **The connection decides the upstream.** The proxy selects `github` or `gitlab` from
   `connector_connections.connector`. For GitLab it builds `gitUrl = serverUrl` and
   `apiUrl = serverUrl + "/api/v4"`, decrypts the token server-side, and sends git with GitLab's HTTP
   Basic (`Authorization: Basic base64("oauth2:<token>")`) and its REST calls with
   `PRIVATE-TOKEN: <token>`; the connection's own token is all GitLab needs. For GitHub the code path is
   the same as v0.1.2: `githubToken` (App installation token when installed, else the connection's token),
   `Basic x-access-token:…`, the hardcoded hosts and the existing App-miss messages.
3. **Scopes follow the connector.** `gitScopes(connector)` returns `github:git.read`/`write` or
   `gitlab:git.read`/`write`; `gitAccess(keys, connection)` reads the grant for that connection and
   connector. `GIT_SCOPES` stays GitHub's value for callers that name it. Repository lists, standing,
   credential checks, limits and audit rows are unchanged, so a GitLab push is `git.push` /
   `git.push_refused` with `connectionId` exactly as a GitHub one is.
4. **The fast-forward check follows the host.** When the pushed pack no longer reaches the old tip, the
   GitHub path still calls `GET {apiUrl}/repos/{o}/{r}/compare/{old}...{oid}` with `githubHeaders` and
   accepts `ahead` or `identical`. A GitLab connection calls
   `GET {apiUrl}/projects/{url-encoded owner/repo}/repository/merge_base?refs[]={old}&refs[]={oid}` and
   accepts it only when the merge base is the old tip; no answer refuses, as on GitHub. Ref rules
   (own `agentes/{handle}/…` branches, no tags, no deletes, no force push) and the refusal report are
   unchanged.
5. **The computer gets our credential, never GitLab's.** `machineGitSetup` prefers the GitHub connection
   and falls back to the GitLab one; `git.sync` then carries the same `agtgit1` token and a proxy base
   whose `connectionId` is the GitLab connection. GitHub App direct-fetch tokens are handed out only when
   the chosen connection is GitHub, and its bot identity is asked only then, so a GitLab sync never
   receives a `ghs_` token and never authors its commits as the GitHub App's bot.
6. **`git_clone` is the one GitLab git tool.** `createGitToolSource` chooses GitHub first, else GitLab,
   and for a GitLab connection exposes only `git_clone` (`gitlab:git.read`), whose description says
   GitLab and whose success text does not point at `open_pull_request`. `serverGitTool` recognizes the
   GitLab scope so the tool stays server-owned. `open_pull_request`, `delete_branches` and
   `request_branch_push` remain GitHub-only; `mcp.ts` skips the GitLab connector (`mcp: false`) instead
   of opening a session against the instance's web URL.

The tests use the existing `GitProxyDeps.upstream` hook. A stub GitLab at `https://gitlab.test` records
the clone request (`GET /acme/app.git/info/refs?service=git-upload-pack`, HTTP Basic with the token) and
the push's merge-base call (`PRIVATE-TOKEN`), then receive-pack. The GitHub tests keep the fake at
`https://github.test` and assert the original URLs and `Basic x-access-token:…` header; no production URL
changes.

## Consequences

- A self-hosted GitLab-only workspace can clone and push through the proxy with the token on the server.
  Where both GitHub and GitLab are connected, GitHub keeps its v0.1.2 behavior and is the connection
  `git.sync` uses; a GitLab clone in that workspace is not offered by `git_clone` yet (it needs a
  per-connection choice in the tool or one proxy base per sync).
- GitHub's proxy requests are unchanged: same defaults, same token path, same headers, same compare URL,
  same messages. `GIT_SCOPES` and the audit actions keep their values.
- The connection is created through `POST /api/app/organizations/{orgId}/connectors` with
  `{"connector":"gitlab","serverUrl":…,"apiKey":…}`. The entry is `listed: false` because the web form
  has no base-URL field yet; listing it and asking for the address in the connector dialog is the remaining
  UI piece before a person can connect it without the API.
- The route shape `{owner}/{repo}.git` does not carry GitLab subgroups (`group/subgroup/repo`). A
  subgroup repository is refused as a path; supporting it means widening the route and the repository
  list, which this series does not do.
- No MR/issue API, no `open_pull_request`, no branch approvals for GitLab. Pushing to someone else's
  branch through the proxy stays GitHub-only, and the proxy refuses it on GitLab with a message that
  names `agentes/<handle>/…`.
- No new env vars, tables, routes or client fields. The connection is a normal catalog connection with
  `gitlab:git.read` / `gitlab:git.write` grants that admins can narrow.

## Verification

- `git apply --check` for each patch, then `git am` for both, on a pristine clone of
  `1abdbe79f5c39f3f4749f02ae8ffa5f469993683`: all exit 0. Transcript in `VERIFY.log`.
- `bun test ./packages/engine/test/git.test.ts ./packages/engine/test/git-machine.test.ts ./packages/engine/test/connectors.test.ts`:
  64 pass, 0 fail, 485 assertions. The new cases: the GitLab connection's base URL and sealed token, the
  clone's URL and git auth, the push's merge-base call with `PRIVATE-TOKEN` and forward, the merge-base
  refusal, the GitLab-only machine sync, `git_clone` as the only GitLab tool, both connections keeping
  GitHub's sync and its four tools, and a GitLab sync never asking for the GitHub App's bot identity.
- `bun run --filter '@agenteschat/engine' typecheck`: exit 0.
- `bun run --filter '@agenteschat/server' typecheck`: exit 0.
- Real-host checks (a live GitLab clone, commit and push, and the GitHub regression) are in `QA.md` and
  marked UNVERIFIED: this lane has no Docker, WSL, GitLab instance or running agentes.chat server.

## Considered and not chosen

- **A GitLab-only table or a new `gitlab_base_url` column.** The connection already has a `server_url`
  and sealed secret columns; reusing them keeps the token under the same envelope encryption and AAD.
- **GitLab OAuth for a self-hosted instance.** Each instance needs its own OAuth application and
  redirect URI. A personal, project or group access token stored server-side covers the same clone/push
  path without a new per-deployment secret; OAuth can be added later behind the same connection.
- **GitLab's compare API for the fast-forward check.** It returns commits and diffs, but not GitHub's
  `ahead`/`identical` verdict; merge-base names the common ancestor directly, and `id === old` is the
  same proof the pack walk uses.
- **A second base URL/API in `GitProxyDeps`.** The `upstream` hook already exists for tests, and the
  production addresses belong to the connection, not the server: a workspace may point at any
  self-hosted instance.
- **One proxy base per repository in `git.sync`.** That is a runner protocol change; with one
  connection per sync, choosing GitHub first (else GitLab) keeps v0.1.2 byte-identical.
- **Opening a GitLab MCP session for tools.** GitLab's web URL is not an MCP endpoint; `mcp: false`
  keeps the connector source from probing it, and `git_clone` is written here.
- **Subgroups in this series.** The route and `agent_repositories` entries are `owner/repo`; widening
  both is a separate change.

## References

- ADR 0024, `docs/adr/0024-git-proxy.md` (and its 2026-10-18 and 2026-10-31 addenda).
- GitLab personal access tokens: https://docs.gitlab.com/user/profile/personal_access_tokens/
- GitLab merge base API: https://docs.gitlab.com/api/repositories/#merge-base
- GitLab smart HTTP: https://docs.gitlab.com/ee/gitlab-basics/start-using-git.html
