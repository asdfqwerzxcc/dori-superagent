#!/usr/bin/env bash
# Back up an agentes.chat instance: the Postgres database, the files volume,
# and the .env file that holds AGENTES_SECRET and POSTGRES_PASSWORD.
#
# Usage:
#   ./backup.sh [--out DIR] [--no-files] [--no-env] [--dry-run]
#
# --out DIR    where the backups go (default: ./backups beside this script)
# --no-files   skip the files volume (only if FILES_DIR is not in use)
# --no-env     skip the .env copy (not recommended: the secret is required
#              to read credentials stored in the database)
# --dry-run    print every command and write nothing
#
# The database dump is consistent while the app runs. Copy the results off
# the server: a backup that only exists on the server is not a backup.
# Keep the .env copy apart from the dumps; anyone holding both can read every
# stored provider and connector credential.

set -euo pipefail

cd -- "$(dirname -- "$0")"

OUT_DIR="backups"
INCLUDE_FILES=1
INCLUDE_ENV=1
DRY_RUN=0

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out|-o)
      [ $# -ge 2 ] || { echo "error: $1 needs a directory" >&2; exit 2; }
      OUT_DIR="$2"
      shift 2
      ;;
    --no-files)
      INCLUDE_FILES=0
      shift
      ;;
    --no-env)
      INCLUDE_ENV=0
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

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP="$OUT_DIR/agentes-$STAMP.dump"
FILES_OUT="$OUT_DIR/files-$STAMP.tar.gz"
ENV_OUT="$OUT_DIR/env-$STAMP.backup"

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN: nothing is written"
  echo "  compose dir : $(pwd)"
  echo "  output dir  : $OUT_DIR"
  echo "  database    : docker compose exec -T postgres pg_dump -U agentes -Fc agentes > $DUMP"
  if [ "$INCLUDE_FILES" = 1 ]; then
    echo "  files       : docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > $FILES_OUT"
  fi
  if [ "$INCLUDE_ENV" = 1 ]; then
    echo "  env         : cp -p .env $ENV_OUT (chmod 600; holds AGENTES_SECRET and POSTGRES_PASSWORD)"
  fi
  echo "  then copy all of $OUT_DIR off the server"
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

if ! docker compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "error: the postgres container is not running; start it with: docker compose up -d postgres" >&2
  exit 1
fi

if [ "$INCLUDE_ENV" = 1 ] && [ ! -f .env ]; then
  echo "error: .env not found in $(pwd); refusing to take a backup without AGENTES_SECRET" >&2
  exit 1
fi

umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

echo "==> database -> $DUMP"
docker compose exec -T postgres pg_dump -U agentes -Fc agentes > "$DUMP"

if [ "$INCLUDE_FILES" = 1 ]; then
  echo "==> files volume -> $FILES_OUT"
  docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > "$FILES_OUT"
fi

if [ "$INCLUDE_ENV" = 1 ]; then
  echo "==> .env -> $ENV_OUT"
  cp -p .env "$ENV_OUT"
  chmod 600 "$ENV_OUT"
fi

echo
echo "Backup complete:"
ls -lh "$DUMP"
if [ "$INCLUDE_FILES" = 1 ]; then
  ls -lh "$FILES_OUT"
fi
if [ "$INCLUDE_ENV" = 1 ]; then
  ls -lh "$ENV_OUT"
fi
echo
echo "Copy $OUT_DIR off this server now."
echo "Keep $ENV_OUT apart from the database dump: together they expose every stored credential."
