# Self-hosted GitLab adapter for agentes.chat v0.1.2

Pinned upstream: `agentes-chat/agentes-chat` tag `v0.1.2`, commit
`1abdbe79f5c39f3f4749f02ae8ffa5f469993683`.

An agent's computer can clone and push a self-hosted GitLab repository through the existing git proxy
(ADR 0024), with the GitLab token staying on the server.

- `0001-gitlab-connection.patch`: the `gitlab` catalog connector (`selfHosted`, no MCP server,
  `listed: false`), `createApiKeyConnection`'s `serverUrl` for it, and `git/gitlab.ts` (base URL, API URL,
  git Basic auth, REST `PRIVATE-TOKEN`, merge-base).
- `0002-gitlab-proxy.patch`: the proxy resolves the host, the credential and the fast-forward check from
  the connection, the computer sync prefers the GitHub connection and falls back to GitLab, and
  `git_clone` is the one GitLab git tool. GitHub's calls, headers and constants are unchanged.
- `APPLY.md`: apply onto the pin, expected files, rollback and post-apply checks.
- `PR.md`: the upstream pull request draft, in ADR style, extending ADR 0024.
- `QA.md`: what to run on a real self-hosted GitLab, each check UNVERIFIED with the reason.
- `VERIFY.log`: captured apply/am, test and type-check output.

Apply `0001` before `0002`. The connection is created through
`POST /api/app/organizations/{orgId}/connectors` with `connector: "gitlab"`, `serverUrl` and `apiKey`;
the web form has no base-URL field yet, which is why the entry is not in "Adicionar conector".

No secrets here: the tokens in the tests and docs are placeholders (`glpat_secret_123456`).
