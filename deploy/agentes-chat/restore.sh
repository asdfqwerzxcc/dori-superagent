#!/usr/bin/env bash
# Restore an agentes.chat instance from a backup made by backup.sh.
#
# Usage:
#   ./restore.sh --dump FILE [--files FILE] [--yes] [--dry-run]
#
# --dump FILE   pg_dump custom-format file (agentes-<stamp>.dump), required
# --files FILE  files volume tarball (files-<stamp>.tar.gz), optional
# --yes         do not ask for confirmation
# --dry-run     print every command and change nothing
#
# The restore stops the app, drops and recreates the database, loads the dump
# with --exit-on-error, optionally unpacks the files volume, and starts the
# app again. If any step fails the app is left stopped on purpose: inspect
# the error before starting it. With --files, the files volume is emptied
# before the archive is unpacked, so files added after the backup do not
# survive the restore.
#
# AGENTES_SECRET must match the one used when the dump was taken, or every
# stored provider and connector credential stays unreadable. On a new server,
# copy the backed-up env-<stamp>.backup to .env (and set PUBLIC_URL) before
# restoring. Restore into the version that took the dump or a newer one;
# migrations only go forward.

set -euo pipefail

cd -- "$(dirname -- "$0")"

DUMP=""
FILES_IN=""
ASSUME_YES=0
DRY_RUN=0

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

# The database path uses pg_restore in the postgres container and needs no
# tar. Only the files volume needs tar; detect it at run time.
require_tar() {
  if ! docker compose run --rm --no-deps -T --entrypoint sh agentes -c 'command -v tar >/dev/null 2>&1'; then
    echo "error: the agentes image provides no tar (or no sh to detect it); the files volume cannot be restored. Omit --files, or add tar to the image." >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dump)
      [ $# -ge 2 ] || { echo "error: --dump needs a file" >&2; exit 2; }
      DUMP="$2"
      shift 2
      ;;
    --files)
      [ $# -ge 2 ] || { echo "error: --files needs a file" >&2; exit 2; }
      FILES_IN="$2"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --dry-run|-n)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$DUMP" ]; then
  echo "error: --dump FILE is required" >&2
  usage >&2
  exit 2
fi

if [ ! -f "$DUMP" ]; then
  echo "error: dump not found: $DUMP" >&2
  exit 1
fi

if [ -n "$FILES_IN" ] && [ ! -f "$FILES_IN" ]; then
  echo "error: files archive not found: $FILES_IN" >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN: nothing is changed"
  echo "  compose dir : $(pwd)"
  echo "  dump        : $DUMP"
  if [ -n "$FILES_IN" ]; then
    echo "  files       : $FILES_IN"
  fi
  echo "  commands    :"
  echo "    docker compose up -d --wait postgres"
  echo "    docker compose stop agentes"
  echo "    docker compose exec -T postgres dropdb -U agentes --force agentes"
  echo "    docker compose exec -T postgres createdb -U agentes agentes"
  echo "    docker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < $DUMP"
  if [ -n "$FILES_IN" ]; then
    echo "    # files restore requires tar in the agentes image; detected at run time"
    echo "    docker compose run --rm --no-deps -T --entrypoint sh agentes -c 'rm -rf -- /data/files/* /data/files/.[!.]* /data/files/..?*'"
    echo "    docker compose run --rm --no-deps -T --entrypoint tar agentes xzf - -C /data/files < $FILES_IN"
  fi
  echo "    docker compose start agentes"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is not installed or not on PATH" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "error: docker compose (Compose v2) is not available" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "error: .env not found in $(pwd); copy the backed-up env file first" >&2
  exit 1
fi

if [ "$ASSUME_YES" = 0 ]; then
  echo "This replaces the database in $(pwd) and stops the app while it runs."
  printf "Type 'restore' to continue: "
  answer=""
  read -r answer || true
  if [ "$answer" != "restore" ]; then
    echo "Aborted; nothing changed."
    exit 1
  fi
fi

echo "==> starting postgres"
docker compose up -d --wait postgres

echo "==> stopping the app"
docker compose stop agentes

trap 'echo "error: restore failed; the app is left stopped and the files volume may be empty or partial. Inspect the output above, then run: docker compose start agentes" >&2' ERR

echo "==> dropping and recreating the database"
docker compose exec -T postgres dropdb -U agentes --force agentes
docker compose exec -T postgres createdb -U agentes agentes

echo "==> restoring $DUMP"
docker compose exec -T postgres pg_restore -U agentes -d agentes --exit-on-error < "$DUMP"

if [ -n "$FILES_IN" ]; then
  require_tar
  echo "==> clearing the files volume"
  docker compose run --rm --no-deps -T --entrypoint sh agentes -c 'rm -rf -- /data/files/* /data/files/.[!.]* /data/files/..?*'
  echo "==> restoring files from $FILES_IN"
  docker compose run --rm --no-deps -T --entrypoint tar agentes xzf - -C /data/files < "$FILES_IN"
fi

echo "==> starting the app"
docker compose start agentes

echo
PORT="$(awk -F= '/^HOST_PORT=/{v=$2} END{print v}' .env 2>/dev/null | sed 's/[[:space:]].*//; s/^"//; s/"$//')"
PORT="${PORT:-3000}"
echo "Restore complete. Check the app:"
echo "  docker compose ps"
echo "  curl -fsS http://127.0.0.1:${PORT}/api/health"
