# QA on a real self-hosted GitLab

This lane could run unit tests, type checks and patch application, but none of the checks below. Mark each
one from your own run; do not read them as passing because the patches apply.

Why they are unverified here: this workstation has no Docker, no WSL, no self-hosted GitLab instance and
no running agentes.chat server, and the lane forbids production secrets or opening a real PR. The unit
tests use a stub upstream at `https://gitlab.test`; that proves the proxy's URL and header, not a real
GitLab's answers.

## 1. A GitLab connection exists with its base URL and sealed token

Status: UNVERIFIED

Steps:

1. Start a server built from v0.1.2 with both patches applied and sign in as a workspace admin.
2. Create the connection (the web form has no base-URL field yet):

   ```sh
   curl -X POST "$AGENTES_URL/api/app/organizations/$ORG_ID/connectors" \
     -H "content-type: application/json" -b cookies.txt \
     -d '{"connector":"gitlab","serverUrl":"https://gitlab.example.com","apiKey":"glpat-…","label":"GitLab"}'
   ```

3. Read `GET /api/app/organizations/$ORG_ID/connectors` and the connection row in
   `connector_connections`.

Pass: `connector` is `gitlab`, `serverUrl` is the instance's base URL, `authType` is `api_key`, and the
response and the row's columns contain no token. `secret_ciphertext` is ciphertext (not the `glpat-…`
string). A request with `serverUrl` missing, `http://` on a public host, or a query/fragment is refused;
a GitHub connection with `serverUrl` is refused.

Fail to report: the token appears in the API response, in a log line, or in plain text in the row;
`serverUrl` is ignored and the catalog default (`https://gitlab.com`) is stored instead.

## 2. Clone a self-hosted GitLab repository through the proxy

Status: UNVERIFIED

Steps:

1. Pair an agent's computer and grant the agent `gitlab:git.read` (plus `gitlab:git.write` for the next
   check) on the GitLab connection.
2. Ask the agent to `git_clone` `group/repo`, or run `git clone` in the agent's folder with the proxy URL
   the `git.sync` base names.
3. Inspect the checkout: `git remote -v`, `git config --get-all credential.helper`, and the credential
   file under the runner's home (`<runner home>/git/<agent id>.token`), not the agent's own folder.

Pass: the clone completes, `origin` is
`$AGENTES_URL/api/git/{orgId}/{connectionId}/group/repo.git`, the credential helper prints our `agtgit1`
token, and `grep -r "glpat-"` over the checkout, the runner's git folder and the agent's folder finds
nothing. GitLab sees git over HTTP Basic (`oauth2:<token>`), and a push's merge-base call with
`PRIVATE-TOKEN`; its token never leaves the server.

Fail to report: a `glpat-…` string on the computer, a clone that asks for the GitLab password, or an
`origin` at `gitlab.example.com` instead of the proxy.

## 3. Commit and push, and the policy refusals

Status: UNVERIFIED

Steps:

1. In the checkout, commit on `agentes/<handle>/qa`, push it through the proxy.
2. Push the same commit to `main`, force-push `agentes/<handle>/qa`, and push to another existing branch
   (`someone/feature`).
3. Rewrite a pushed commit and push again (a non-fast-forward).
4. Read the workspace audit log.

Pass: the first push creates the branch on GitLab and is `git.push` in the audit log with the connection
and refs. The other pushes are refused before reaching GitLab: `main` and `someone/feature` say the
branch rule, the force push says "not a fast-forward (force pushes are not allowed)", and the rewritten
history is refused by the merge-base check. Each prints `remote: agentes:` lines and ends with the
no-terminal-commands line. GitLab's own branch protection may also refuse; agentes' refusal must come
first.

Fail to report: a push to `main`, a tag, a delete or a force push reaching GitLab; a refusal that comes
from GitLab rather than the proxy; a fast-forward push refused because the merge-base call failed (check
the token's `api` scope; a project/group token needs `api` or at least `read_repository` and
`read_api`).

## 4. GitHub is unchanged

Status: UNVERIFIED

Steps:

1. In a workspace with a GitHub connection (and no GitLab one), repeat the clone and an
   `agentes/<handle>/…` push from the same computer.
2. Put a recording proxy in front of `https://github.com` and `https://api.github.com`, or read the
   proxy's outbound log if the test host has one.

Pass: the clone goes to `https://github.com/{owner}/{repo}.git/...` with
`Basic x-access-token:<org token>` (or the GitHub App installation token), the push's compare call goes
to `/repos/{owner}/{repo}/compare/...` with `Bearer`, and the branch lands on GitHub. With both connectors
connected, `git.sync` still names the GitHub connection.

Fail to report: a `PRIVATE-TOKEN` header to GitHub, a `github.test`-style test host in production, or a
GitHub clone that uses the GitLab base URL.

## 5. A GitLab subgroup repository

Status: UNVERIFIED (and expected to be refused)

The proxy route is `{owner}/{repo}.git`, so `group/subgroup/repo` is not a path it parses. Steps: try a
clone of a subgroup repository.

Pass for this series: the request is refused as "not a git repository path" (404), and the agent is told
to use a top-level `group/repo`. Supporting subgroups is a separate route change.

## Already verified in this lane

- Both patches apply to `1abdbe79f5c39f3f4749f02ae8ffa5f469993683` with `git apply --check` (exit 0) and
  apply with `git am` (exit 0). See `VERIFY.log`.
- `bun test ./packages/engine/test/git.test.ts ./packages/engine/test/git-machine.test.ts ./packages/engine/test/connectors.test.ts`:
  64 pass, 0 fail, 485 assertions, including the GitLab clone URL and git auth, the merge-base push and
  its refusal, the GitLab-only machine sync, both connections keeping GitHub's sync and tools, a GitLab
  sync never asking for the GitHub App's bot identity, and the connection's sealed token.
- `bun run --filter '@agenteschat/engine' typecheck`: exit 0.
- `bun run --filter '@agenteschat/server' typecheck`: exit 0.
- `bun test ./apps/server/test/connectors.test.ts`: the route with the optional `serverUrl` still passes.
