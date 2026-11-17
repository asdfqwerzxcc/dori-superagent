# Applying the self-hosted GitLab patches

Pinned upstream: `agentes-chat/agentes-chat` tag `v0.1.2`, commit
`1abdbe79f5c39f3f4749f02ae8ffa5f469993683`.

The two patches are a series: `0001` adds the connection type, the `gitlab:git.read` / `gitlab:git.write`
scopes and the GitLab helpers; `0002` teaches the proxy, the computer sync and the `git_clone` tool to
use them. Apply `0001` before `0002`. Each applies alone on the pinned tree, but `0002` does not run
without `0001`'s `git/gitlab.ts`.

## Apply onto v0.1.2

```sh
git clone --branch v0.1.2 https://github.com/agentes-chat/agentes-chat.git agentes-chat
cd agentes-chat
git rev-parse HEAD
# 1abdbe79f5c39f3f4749f02ae8ffa5f469993683

PATCHES=/path/to/patches/agentes-chat-gitlab

git apply --check "$PATCHES/0001-gitlab-connection.patch"
git apply --check "$PATCHES/0002-gitlab-proxy.patch"

git am "$PATCHES/0001-gitlab-connection.patch"
git am "$PATCHES/0002-gitlab-proxy.patch"
```

PowerShell users can run the same commands; replace `$PATCHES/...` with the full Windows paths
(for example `C:\patch\0001-gitlab-connection.patch`).

## Expected result

```
$ git log --oneline -2
<sha> feat(gitlab): clone and push through the proxy
<sha> feat(gitlab): connect a self-hosted GitLab
```

Files touched:

| Patch | Files |
| --- | --- |
| `0001-gitlab-connection.patch` | `apps/server/src/routes/app/connectors.ts`, `packages/engine/src/connectors/catalog.ts`, `packages/engine/src/connectors/connections.ts`, `packages/engine/src/connectors/listing.ts`, `packages/engine/src/connectors/mcp.ts`, `packages/engine/src/git/gitlab.ts` (new), `packages/engine/src/index.ts`, `packages/engine/test/connectors.test.ts` |
| `0002-gitlab-proxy.patch` | `packages/engine/src/git/machine.ts`, `packages/engine/src/git/proxy.ts`, `packages/engine/src/git/tools.ts`, `packages/engine/src/tools/gateway.ts`, `packages/engine/test/git.test.ts`, `packages/engine/test/git-machine.test.ts` |

No other files change. `0001` adds a catalog connector (`gitlab`, `selfHosted: true`, no MCP server),
lets `createApiKeyConnection` take a `serverUrl` for such a connector, seals the token in
`connector_connections` exactly as GitHub's, and adds `git/gitlab.ts` (base URL, git auth, the REST
`PRIVATE-TOKEN` header, merge-base). `0002` resolves the proxy's git URL, API URL, credential and
fast-forward check from the connection's connector; picks the GitLab connection for `git.sync` when no
GitHub one is connected;
and offers `git_clone` on a GitLab connection (pull requests, branch deletion and branch approvals stay
GitHub-only).

## Creating the connection

The web app's API-key form has no base-URL field yet (no UI work in this series), so the catalog entry is
marked `listed: false` and the connection is created through the API an admin already uses:

```sh
curl -X POST "$AGENTES_URL/api/app/organizations/$ORG_ID/connectors" \
  -H "content-type: application/json" \
  -b cookies.txt \
  -d '{"connector":"gitlab","serverUrl":"https://gitlab.example.com","apiKey":"glpat-…","label":"GitLab"}'
```

`serverUrl` is the instance's base URL, https (http only on localhost), with no query, fragment or
credentials in it. The response is `connectionView`: it names the connector, label and base URL, and
never the token. Setting `serverUrl` on a connector that is not self-hosted is refused.

## Rollback

While `git am` is stopped on a patch:

```sh
git am --abort
```

After both patches applied:

```sh
git reset --hard 1abdbe79f5c39f3f4749f02ae8ffa5f469993683
```

Use `git reset --hard HEAD~2` instead if the pinned commit is not available locally.

## What to verify after applying

Fast checks:

```sh
bun install --frozen-lockfile
bun test ./packages/engine/test/git.test.ts ./packages/engine/test/git-machine.test.ts ./packages/engine/test/connectors.test.ts
bun run --filter '@agenteschat/engine' typecheck
bun run --filter '@agenteschat/server' typecheck
```

The three test files pass with the series: 62 pass, 0 fail, 473 assertions (see `VERIFY.log`). The GitLab
cases are a stub upstream at `https://gitlab.test`: a clone goes to the instance's URL with HTTP Basic
(`oauth2:<token>`, GitLab's git-over-HTTPS way), a push asks its merge-base API with `PRIVATE-TOKEN` and
then forwards to receive-pack, and a merge base that is not the old tip refuses the push. The GitHub
cases in the same files still assert the original
`https://github.test/...` URLs and `Basic x-access-token:…` header.

`bun run --filter '@agenteschat/server' typecheck` is clean; the route change only adds an optional
`serverUrl` to the API-key body. The web app still needs a base-URL field on the GitLab connector card
before a person can connect it without the API; that is a UI follow-up, not part of this series.

On a real self-hosted GitLab, run the checks in `QA.md`: clone and push through the proxy, and the
GitHub regression. They are marked UNVERIFIED here (no Docker, WSL, GitLab instance or running server).
