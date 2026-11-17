# Upgrading and rolling back agentes.chat

This package pins the app to upstream release `v0.1.2`:

```
ghcr.io/agentes-chat/agentes:0.1.2@sha256:d6bde5d5b68510a7d8a309b0491ec1431ffeeb815f019c2b9bdaf269e004ad4f
```

Upstream read for this package: `v0.1.2`, commit
`1abdbe79f5c39f3f4749f02ae8ffa5f469993683` (2026-11-15). The compose file and
Dockerfile are byte-identical to `main` at `dedc5582d8c5e4aefa5c3ca120fc0a6ea66e8cd3`
(2026-11-17); the docs quoted below are the `v0.1.2` tag, which matches the
image.

## Back up exactly these three things first

From `SELF_HOSTING.md` @ v0.1.2, section "Backups and restore":

> An instance is three things: the database, the `files` volume (uploaded files,
> with the compose file's `FILES_DIR`), and `AGENTES_SECRET`. Keep the secret
> apart from the dumps: a dump restored without it has every stored key (model
> providers, connectors, mailboxes, databases) unreadable, and anyone who holds
> both can read those keys.

1. **The database.** A custom-format `pg_dump`:
   `docker compose exec -T postgres pg_dump -U agentes -Fc agentes`.
2. **The `files` volume.** Uploaded files, unless the instance stores them in
   an S3 bucket instead (`S3_BUCKET` set): those files stay in that bucket and
   need the bucket's own backup.
3. **`AGENTES_SECRET`.** It lives in `.env` together with `POSTGRES_PASSWORD`.

If this server is also the agents' computer (`HOST_COMPUTER_TOKEN` set), copy
`host-computer-token` beside `.env` too: upstream keeps the same token there.

`./backup.sh` does all three and writes `agentes-<stamp>.dump`,
`files-<stamp>.tar.gz` and `env-<stamp>.backup` into `./backups`:

```sh
./backup.sh
# then copy ./backups off the server
```

Keep the `.env` copy apart from the dumps. Upstream's own wording on why:

> Keep the secret apart from the dumps: a dump restored without it has every
> stored key ... unreadable, and anyone who holds both can read those keys.

If the app stores files in S3, take a bucket snapshot or a bucket-level backup
as well; `backup.sh` only covers the `files` volume.

## Upgrade procedure

Upstream's rule, from "Upgrades":

> Migrations run when the new version starts, so that is the whole upgrade for a
> small instance.

And on holding a version:

> To hold a version, set `AGENTES_IMAGE` in `.env` to a version tag or a digest
> (`ghcr.io/agentes-chat/agentes@sha256:...`), and keep that version's compose
> file. This prints the digest you have:
>
> ```sh
> docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/agentes-chat/agentes:latest
> ```

1. **Record the current pin.**

   ```sh
   grep '^AGENTES_IMAGE=' .env
   ```

2. **Back up, and copy the backup off the server.**

   ```sh
   ./backup.sh
   ```

3. **Read the target release.** Open
   `https://github.com/agentes-chat/agentes-chat/releases` and read
   `SELF_HOSTING.md` at that tag, section "Upgrades". Compare the release's
   `docker-compose.yml` with this one; a release can add a service or an
   environment variable. Upstream:

   > Download the compose file again with each release, since a release can
   > change it, then pull and restart.

   Do not replace this compose file blindly: it is deliberately trimmed to the
   services below and every image is pinned. Port the differences instead.

4. **Pull the new image and resolve its digest.**

   ```sh
   docker pull ghcr.io/agentes-chat/agentes:<tag>
   docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/agentes-chat/agentes:<tag>
   ```

5. **Set the new pin in `.env`.** Use both the readable tag and the immutable
   digest:

   ```
   AGENTES_IMAGE=ghcr.io/agentes-chat/agentes:<tag>@sha256:<digest>
   ```

6. **Pull the pinned image.**

   ```sh
   docker compose pull
   ```

7. **For a big jump, migrate first.** Upstream:

   > For a big jump, migrate first from a throwaway container. If a migration
   > fails, the running version keeps serving instead of a new one that won't
   > start:
   >
   > ```sh
   > docker compose pull
   > docker compose run --rm agentes migrate
   > docker compose up -d
   > ```

   For a small jump, skip this: migrations run when the new version starts.

8. **Start the new version.**

   ```sh
   docker compose up -d
   ```

9. **Verify.**

   ```sh
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health
   docker compose logs --tail=100 agentes
   ```

   `ps` must show `postgres` and `agentes` as `healthy`; the health endpoint
   must answer `{"status":"ok",...}`. If it does not, roll back.

## Rollback

Upstream's constraint, from "Upgrades":

> Migrations only go forward, and a version refuses to start on a database that
> a newer one migrated. Take a dump before a big jump (Backups below): rolling
> back is the previous pin plus that dump.

That means a rollback is two changes, not one: the old image pin **and** the
pre-upgrade database dump. Reverting only `AGENTES_IMAGE` can leave the app
refusing to start on the newer schema.

1. **Stop the app.**

   ```sh
   docker compose stop agentes
   ```

2. **Put the previous pin back in `.env`.**

3. **Restore the pre-upgrade database and files.** `restore.sh` starts
   Postgres, drops and recreates the database, restores with
   `pg_restore --exit-on-error`, unpacks the files volume and starts the app.

   ```sh
   ./restore.sh \
     --dump backups/agentes-<stamp>.dump \
     --files backups/files-<stamp>.tar.gz \
     --yes
   ```

4. **Make sure the old pin is what is running.**

   ```sh
   docker compose up -d
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health
   ```

If the restore fails, the app is left stopped on purpose. Inspect the error
before starting it; starting it against a half-restored database can make the
next restore harder.

## Postgres major versions

The Postgres image is pinned too. From "Upgrades":

> The compose file pins the Postgres image too, by version and digest, so the
> database image changes only when a release's compose file moves that pin.
> ... That covers Postgres 18 minor releases and pgvector updates; a new
> Postgres major version can't open the old data directory, so moving to one
> takes a dump and a restore into a new volume.

Do not move `pgvector/pgvector` to a new major version independently of an
upstream release. If a release does, follow the dump-and-restore path: dump
with the old image, stop the stack, start a new empty `pgdata` volume, restore,
then start the app.

## Reboots

From "Rebooting the server":

> A reboot stops every container at once, so Postgres can go before the app
> saves the runs in progress. Stop the app first: runs get up to 20 s to
> finish, and the rest are saved and go on when it starts again.

```sh
docker compose stop agentes
sudo reboot
# after boot, in this directory:
docker compose up -d
```

## Sources

All quotes are from `SELF_HOSTING.md` at tag `v0.1.2`
(commit `1abdbe79f5c39f3f4749f02ae8ffa5f469993683`):

- "Upgrades": compose download, `AGENTES_IMAGE`, migrate-first, forward-only
  migrations, Postgres major versions.
- "Backups and restore": the three things to back up, the hand-run dump and
  restore commands, S3 files, age encryption.
- "Rebooting the server": stop the app before a reboot.

Nothing in this file was executed against a live stack: this machine has no
Docker and no WSL. The commands are the upstream procedures adapted to this
package's pinned compose file.
