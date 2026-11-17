# First-boot checklist: agentes.chat self-host

Written against `SELF_HOSTING.md` at tag `v0.1.2`, commit
`1abdbe79f5c39f3f4749f02ae8ffa5f469993683` (2026-11-15), which matches the
pinned image in `.env.example`.

**This machine has no Docker and no WSL. The stack was not started here.**
Every command below is the upstream procedure adapted to this package; a step
that upstream does not document is marked **UNVERIFIED**. A step marked
**VERIFIED FROM DOCS** has the upstream quote beside it.

Legend:

- **VERIFIED FROM DOCS** - the upstream `SELF_HOSTING.md` section quoted says
  exactly this.
- **UNVERIFIED** - not in upstream docs, or depends on this server; confirm it
  on the real machine before relying on it.

## 1. First boot

### 1.1 Server prerequisites

- [ ] 64-bit Linux (amd64 or arm64), Docker Engine with the Compose v2 plugin,
  `docker compose` 2.23.1 or newer. **VERIFIED FROM DOCS**, "Self-hosting
  agentes.chat", Requirements:

  > A 64-bit Linux server (amd64 or arm64) ... It runs on Docker Engine with the
  > Compose v2 plugin (`docker compose`), 2.23.1 or newer.

- [ ] Sizing: start at 2 vCPUs, 4 GB of RAM, 20 GB of disk. **VERIFIED FROM
  DOCS**, same section:

  > As a starting point for a small team: 2 vCPUs, 4 GB of RAM and 20 GB of
  > disk. The image is large (about 2 GB of dependencies), and the database and
  > the files volume grow with use.

- [ ] Outbound HTTPS to the model providers you will use, and to any optional
  service you turn on. **VERIFIED FROM DOCS**, same section:

  > Outbound HTTPS to the model providers your organizations use, and to any
  > service you turn on below.

- [ ] If using `COMPOSE_PROFILES=https`: a domain whose DNS points at this
  server, and ports 80 and 443 open. **VERIFIED FROM DOCS**, "A public domain
  instead (Caddy)":

  > point a DNS record at the server, open ports 80 and 443

- [ ] If using `COMPOSE_PROFILES=tailscale`: a tailnet with MagicDNS and HTTPS
  certificates enabled, and an auth key or OAuth client secret. **VERIFIED
  FROM DOCS**, "Quick start" steps 2-3.

### 1.2 Create `.env`

- [ ] `cp .env.example .env` and `chmod 600 .env`. **VERIFIED FROM DOCS**,
  "This machine only, and by hand":

  > The `umask` in parentheses makes `.env` readable by you alone without
  > changing your shell's.

- [ ] Generate `POSTGRES_PASSWORD` with `openssl rand -hex 24`. It must stay
  hex. **VERIFIED FROM DOCS**, "This machine only, and by hand":

  > `POSTGRES_PASSWORD` goes into the database URL the compose file builds, so
  > it stays hex.

- [ ] Generate `AGENTES_SECRET` with `openssl rand -base64 48`. **VERIFIED
  FROM DOCS**, `.env.example` and "Configuration":

  > Master secret, at least 32 characters. Never change it on an instance in
  > use.

- [ ] Set `PUBLIC_URL` to the exact address people open, with scheme, host and
  port, and no trailing slash. **VERIFIED FROM DOCS**, "Self-hosting
  agentes.chat":

  > `PUBLIC_URL` must be the exact address people open, scheme, host and port
  > included (`https://agentes.tail1234.ts.net`, `https://chat.example.com`, or
  > `http://localhost:3000` on your own machine).

- [ ] Choose the way in with `COMPOSE_PROFILES`. **VERIFIED FROM DOCS**,
  "Configuration":

  > How people reach it: `tailscale` (the setup's default), `https` (Caddy for
  > `DOMAIN`), or neither (this machine only). Comma-separated, with other
  > optional services: `backup` (Backups and restore), `speech` (Voice
  > messages), `embeddings` (Search across languages).

  This package's profiles are `tailscale`, `https`, `speech` and `embeddings`;
  backups are `backup.sh` and `restore.sh` here, not a compose profile.

- [ ] For `https`, do the first boot in two phases. Start with
  `PUBLIC_URL=http://localhost:3000` and `COMPOSE_PROFILES=` empty, create the
  owner over localhost or an SSH tunnel (section 3), then set `DOMAIN`,
  `PUBLIC_URL=https://DOMAIN` and `COMPOSE_PROFILES=https` and run
  `docker compose up -d` again. **VERIFIED FROM DOCS**, "A public domain
  instead (Caddy)":

  > Create the owner account first, over localhost or the SSH tunnel (This
  > machine only, below): the first sign-up becomes the owner, so it has to
  > happen before the domain answers. Then point a DNS record at the server,
  > open ports 80 and 443, and add to `.env`:
  >
  > ```sh
  > DOMAIN=chat.example.com
  > PUBLIC_URL=https://chat.example.com
  > COMPOSE_PROFILES=https
  > ```
  >
  > and run `docker compose up -d`.

- [ ] For `https`, leave `TRUSTED_PROXIES` empty. **VERIFIED FROM DOCS**, same
  section:

  > Caddy sends the client's address as the only value of `X-Forwarded-For`,
  > which the app trusts as is, so leave `TRUSTED_PROXIES` empty.

- [ ] For `tailscale`, set `TS_AUTHKEY`, keep `TS_HOSTNAME=agentes` or choose
  another name, and leave `TAILSCALE_FUNNEL=false` unless you want the instance
  public. **VERIFIED FROM DOCS**, "Quick start" and "What needs a public URL".

- [ ] Optional: set `OWNER_CLAIM_SHA256` to lock the first account to a one-time
  owner link. **VERIFIED FROM DOCS**, "Sign-up":

  > To keep the first account for its owner, set `OWNER_CLAIM_SHA256` to the
  > SHA-256 (hex) of a one-time token ... then only
  > `<PUBLIC_URL>/owner#claim=<token>` creates it, with a password, and every
  > other sign-up waits until it has.

### 1.3 Start

- [ ] Start the stack:

  ```sh
  docker compose up -d
  ```

- [ ] For `https` or an existing public proxy, create the owner account now,
  over localhost or an SSH tunnel, before DNS or the proxy answers. The app is
  published on `127.0.0.1:3000` by default, so `ssh -L 3000:localhost:3000
  your-server` reaches it. **VERIFIED FROM DOCS**, "A public domain instead
  (Caddy)" (quoted above).

  The first pull is about 2 GB. **VERIFIED FROM DOCS**, "Quick start":

  > The first time, it downloads about 2 GB, and the agents' computer takes a
  > few minutes more.

- [ ] Watch the boot and the migrations:

  ```sh
  docker compose logs -f agentes
  ```

  **VERIFIED FROM DOCS**, "Quick start":

  > `docker compose ps` shows the app as `healthy` once it answers
  > `/api/health`, and `docker compose logs -f agentes` shows what it is doing.

## 2. Health check

- [ ] Containers are up and healthy:

  ```sh
  docker compose ps
  ```

  **VERIFIED FROM DOCS**, "Quick start" (quoted above) and the "For AI agents"
  check table:

  > | Containers | `docker compose ps` | `postgres`, `agentes` and `tailscale` up
  > and `healthy` |

- [ ] The app answers its health endpoint:

  ```sh
  curl -fsS http://127.0.0.1:3000/api/health
  ```

  Expected: `{"status":"ok",...}`. **VERIFIED FROM DOCS**, "For AI agents"
  check table:

  > | App | `curl -fsS http://127.0.0.1:3000/api/health` | `{"status":"ok",...}` |

- [ ] End to end, from a device that can reach the instance (another device in
  the tailnet, or the public internet for `https`):

  ```sh
  curl -fsS https://<your address>/api/health
  ```

  The same answer. **VERIFIED FROM DOCS**, "For AI agents" check table:

  > | End to end, from a device in the tailnet | `curl -fsS
  > https://agentes.<tailnet>.ts.net/api/health` | the same |

- [ ] Put an external uptime check on `/api/health`. **VERIFIED FROM DOCS**,
  "Rebooting the server":

  > An uptime check from outside the server on `https://<your address>/api/health`
  > is worth having: it answers 200 only while the app and its database are up,
  > so it tells you when the server doesn't come back.

- [ ] If the app is not healthy: `docker compose logs agentes`. An
  `Invalid configuration` line names a missing or malformed `.env` value; an
  `extension "vector" is not available` line means Postgres is not the
  `pgvector/pgvector` image. **VERIFIED FROM DOCS**, "Troubleshooting".

## 3. First login

- [ ] Open `PUBLIC_URL` on a device that can reach it and sign up. The first
  account owns the installation. **VERIFIED FROM DOCS**, "Quick start":

  > On a computer in your tailnet, open that address and sign up. The first
  > account is always allowed and becomes the owner; after it, sign-up is
  > closed and people join by invitation.

  **VERIFIED FROM DOCS**, "Sign-up":

  > The first account is allowed unless an owner link or the desktop app's owner
  > key holds it (below). After it, with `ALLOW_SIGNUP=false` (the default),
  > only invited people get in ...

- [ ] Add the organization's model key in **Settings → AI and usage**.
  **VERIFIED FROM DOCS**, "AI: plans and keys":

  > Each organization adds its own provider keys in **Settings → AI and
  > usage**. They are stored encrypted with a key derived from `AGENTES_SECRET`,
  > never sent back to a browser, and every model call goes through the server,
  > which records its usage and cost per agent.

- [ ] Optional, but do it before inviting people: set up email with `SMTP_URL`
  or `MILLIONSEND_API_KEY`, then `docker compose up -d`. Without it, emails are
  only logged. **VERIFIED FROM DOCS**, "Email":

  > Without `SMTP_URL` or `MILLIONSEND_API_KEY`, the app writes each email to its
  > log instead of sending it (`docker compose logs agentes | grep 'email (not
  > sent'`), so an invitation link can still be copied from there; email
  > verification and password reset stay off.

- [ ] Confirm the app's own About/instance information shows the version you
  pinned (`GET /api/instance` and `/api/health`). **VERIFIED FROM DOCS**,
  `.env.example`, `APP_VERSION`:

  > version in GET /api/instance and /api/health

## 4. Invite one member and add one agent member

### 4.1 Invite one human member

- [ ] Invite them from **Settings → Members and invitations**. **VERIFIED
  FROM DOCS**, "Sign-up":

  > only invited people get in: invited by email from **Settings → Members and
  > invitations**

- [ ] On Tailscale, the person must also be in your tailnet. **VERIFIED FROM
  DOCS**, "Quick start":

  > **People you invite** need your tailnet too: invite them at
  > https://console.tailscale.com/admin/users (**Invite users**), or share only
  > this server with their tailnet ... Then invite them in the app, from
  > **Settings → Members and invitations**.

### 4.2 Add one agent member

- [ ] Create one agent in the workspace, give it an owner, and give it a model
  from the organization's key. **UNVERIFIED** for the exact UI path:
  `SELF_HOSTING.md` at v0.1.2 does not document creating an agent (searched
  for "New agent", "Add agent" and "create an agent": 0 hits). What upstream
  does document, in `README.md` at v0.1.2:

  > Agents join your channels and DMs with a role, an owner and a budget, work
  > where everyone can see, and ask before anything sensitive.

  > Each has a role, instructions, a model (Claude, OpenAI, Gemini, DeepSeek,
  > Kimi, Z.ai, MiniMax, Command Code, or any of OpenRouter's), a monthly budget
  > checked before every call, and an owner who gets its approvals and budget
  > alerts.

- [ ] Optional: give the agent a computer. For a Linux server or VM, **Settings
  → Devices → Connect a device** shows the command. **VERIFIED FROM DOCS**,
  "Connect a computer":

  > **Linux, a server or a VM:** **Settings › Devices › Connect a device**
  > shows the command, and Agent computers below explains it.

- [ ] Test it: in a channel, @mention the agent and confirm it replies. The
  behavior is documented in `README.md` ("Agents ... answer when it's theirs to
  answer"), but the exact UI path and the reply are **UNVERIFIED** until run on
  this server.

## 5. The three unknowns to confirm on the real server

### 5.1 Reverse proxy

**Question:** will this instance sit behind Caddy (`COMPOSE_PROFILES=https`),
Tailscale (`COMPOSE_PROFILES=tailscale`), or an existing proxy (nginx, Traefik,
a CDN)?

- [ ] If Caddy: `DOMAIN` set, ports 80 and 443 open, `PUBLIC_URL=https://DOMAIN`,
  `TRUSTED_PROXIES` empty. **VERIFIED FROM DOCS**, "A public domain instead
  (Caddy)".
- [ ] If Tailscale: MagicDNS and HTTPS on, `TS_AUTHKEY` set, `PUBLIC_URL` equal
  to the `ts.net` address. **VERIFIED FROM DOCS**, "Quick start".
- [ ] If an existing proxy: keep `BIND_ADDRESS=127.0.0.1` and point the proxy at
  `127.0.0.1:3000`. The proxy must satisfy all four requirements. **VERIFIED
  FROM DOCS**, "Behind your own reverse proxy (nginx)":

  > - upgrade WebSockets on `/api/ws` (browsers), `/api/machines/connect`
  >   (connected computers), and `/api/desktop`, `/api/terminal` and
  >   `/api/machines/stream` (agents' screens and terminals);
  > - accept request bodies up to 100 MB: files for the Drive (50 MB each) and
  >   agents' git pushes (up to 100 MB);
  > - keep sockets open: the app and its clients exchange a ping at least every
  >   30 s, so a read timeout of 60 s (nginx's default) or more works;
  > - send the client's address in `X-Forwarded-For`.

- [ ] If another proxy or CDN sits in front of your proxy, send the
  `X-Forwarded-For` chain and list those proxies in `TRUSTED_PROXIES`.
  **VERIFIED FROM DOCS**, same section:

  > With another proxy or a CDN in front of nginx, send the chain instead
  > (`$proxy_add_x_forwarded_for`) and list those proxies' addresses or ranges
  > in `TRUSTED_PROXIES`, comma-separated: the chain is read from the right past
  > every trusted hop, and the first other address is the client.

- [ ] **UNVERIFIED:** your actual proxy configuration, and the end-to-end test
  of a browser WebSocket plus a file upload over 50 MB. Run both on the real
  server; a proxy that passes `/api/health` can still break WebSockets or
  uploads.

### 5.2 AD / Google login

**Question:** is email/password plus Google enough, or does the operator need
Active Directory / LDAP / SAML / OIDC single sign-on?

- [ ] Google sign-in is supported. Set `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET`; the redirect URI is
  `{PUBLIC_URL}/api/auth/callback/google`. **VERIFIED FROM DOCS**,
  "Configuration":

  > `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | "Sign in with Google",
  > redirect URI `{PUBLIC_URL}/api/auth/callback/google`. `GITHUB_*` and
  > `APPLE_*` work the same way.

- [ ] AD / LDAP / SAML / OIDC is **not documented** in `SELF_HOSTING.md` at
  v0.1.2 (searched: "LDAP", "Active Directory", "SAML", "OIDC": 0 hits). The
  documented sign-in methods are email/password, Google, GitHub and Apple.
  Treat AD/SSO as **UNVERIFIED / unsupported** by this package until the
  operator confirms a different path.

- [ ] Keep `ALLOW_SIGNUP=false` on an internet-reachable instance. **VERIFIED
  FROM DOCS**, "Sign-up":

  > Keep sign-up closed on an instance reachable from the internet.

### 5.3 Backup destination

**Question:** where do the database dump, the files archive and the `.env` copy
go, and has a restore been tested from there?

- [ ] `./backup.sh` writes to `./backups` on this server. That is not an
  off-site backup. **UNVERIFIED** until the operator names the destination
  (another host, a NAS, an S3-compatible bucket, a backup service).

- [ ] Copy `./backups` off the server after every run, and keep the
  `env-<stamp>.backup` apart from the database dump. **VERIFIED FROM DOCS**,
  "Backups and restore":

  > Keep the secret apart from the dumps: a dump restored without it has every
  > stored key ... unreadable, and anyone who holds both can read those keys.

- [ ] If the instance stores files in S3 (`S3_BUCKET` set), the `files` volume
  is not where they live; back up that bucket too. **VERIFIED FROM DOCS**,
  "Backups and restore":

  > The dumps cover the database, files kept in Postgres included. Files in an
  > S3 bucket stay there; files in the `files` volume need the commands below.

- [ ] Upstream also offers a built-in `backup` profile that dumps to an
  S3-compatible bucket on a schedule, optionally encrypted with age. This
  package does not include that service; use it as an alternative or a second
  copy if the operator wants it. **VERIFIED FROM DOCS**, "Backups and restore":

  > The `backup` service dumps the database at 03:00 UTC to a bucket on
  > Cloudflare R2 or another S3-compatible store, and deletes dumps older than
  > `BACKUP_RETENTION_DAYS` (14 by default).

  > A dump leaves the server as `pg_dump` wrote it unless `BACKUP_AGE_RECIPIENT`
  > holds an age public key (`age1…`): then each dump is encrypted to that key
  > before it is uploaded.

- [ ] **UNVERIFIED:** the destination, its retention, its encryption, and a
  real restore from it. Run a restore drill into a scratch instance (or at
  least a scratch database) before relying on the backup.

## 6. Do not

- [ ] Do not change `AGENTES_SECRET` on a running instance. Stored provider and
  connector credentials become unreadable. **VERIFIED FROM DOCS**,
  "Configuration": "Never change it on an instance in use."
- [ ] Do not set `BIND_ADDRESS=0.0.0.0` without TLS in front. **VERIFIED FROM
  DOCS**, "This machine only, and by hand":

  > Don't serve it over plain http to other machines (`BIND_ADDRESS=0.0.0.0`),
  > not even on a LAN.

- [ ] Do not edit `docker-compose.yml` for settings; use `.env`, or a
  `docker-compose.override.yml` for what a variable cannot set. **VERIFIED FROM
  DOCS**, "Upgrades":

  > Keep your settings in `.env` and never edit `docker-compose.yml`, so
  > replacing it loses nothing. Anything a variable can't set goes in a
  > `docker-compose.override.yml` beside it, which Compose merges on its own.

- [ ] Do not publish Postgres. This compose file publishes only the app, on
  loopback by default; Caddy publishes 80 and 443.

## 7. What was verified on the machine that produced this package

Run `./verify.sh` to repeat all three checks:

- `docker-compose.yml` parses with Bun's YAML parser: 6 services, 5 volumes.
- Compose interpolation variables and `.env.example` variables match in both
  directions (42 interpolated, 43 defined, 1 compose-native:
  `COMPOSE_PROFILES`); the three required values are empty placeholders; the
  app image carries an `@sha256` digest.
- `backup.sh`, `restore.sh` and `verify.sh` pass `bash -n`.

Not run here, because this machine has no Docker and no WSL: the stack itself,
`docker compose up`, the health endpoint, first login, the agent member, and a
restore drill. Those are the checks in sections 1-5 that stay **UNVERIFIED**
until the operator runs them on the real server.
