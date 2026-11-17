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
# A relative --out resolves from this script's directory, not your shell's.
# A failed run leaves <name>.partial files; they are not valid backups.
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

# The database path uses pg_dump in the postgres container and needs no tar.
# Only the files volume needs tar; detect it at run time instead of assuming it.
require_tar() {
  if ! docker compose run --rm --no-deps -T --entrypoint sh agentes -c 'command -v tar >/dev/null 2>&1'; then
    echo "error: the agentes image provides no tar (or no sh to detect it); the files volume cannot be backed up. Use --no-files, or add tar to the image." >&2
    exit 1
  fi
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
DUMP_PART="$DUMP.partial"
FILES_PART="$FILES_OUT.partial"
ENV_PART="$ENV_OUT.partial"

if [ "$DRY_RUN" = 1 ]; then
  echo "DRY RUN: nothing is written"
  echo "  compose dir : $(pwd)"
  echo "  output dir  : $OUT_DIR"
  echo "  database    : docker compose exec -T postgres pg_dump -U agentes -Fc agentes > $DUMP"
  if [ "$INCLUDE_FILES" = 1 ]; then
    echo "  files       : docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > $FILES_OUT (requires tar in the agentes image; detected at run time)"
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
if [ ! -d "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR"
  chmod 700 "$OUT_DIR"
fi

CHECK=("$DUMP" "$DUMP_PART")
if [ "$INCLUDE_FILES" = 1 ]; then
  CHECK+=("$FILES_OUT" "$FILES_PART")
fi
if [ "$INCLUDE_ENV" = 1 ]; then
  CHECK+=("$ENV_OUT" "$ENV_PART")
fi
for f in "${CHECK[@]}"; do
  if [ -e "$f" ]; then
    echo "error: $f already exists; wait a second and retry, or remove the stale file" >&2
    exit 1
  fi
done

trap 'echo "error: backup failed; files ending in .partial are incomplete and must not be used" >&2' ERR

echo "==> database -> $DUMP"
docker compose exec -T postgres pg_dump -U agentes -Fc agentes > "$DUMP_PART"
mv "$DUMP_PART" "$DUMP"

if [ "$INCLUDE_FILES" = 1 ]; then
  require_tar
  echo "==> files volume -> $FILES_OUT"
  docker compose run --rm --no-deps -T --entrypoint tar agentes czf - -C /data/files . > "$FILES_PART"
  mv "$FILES_PART" "$FILES_OUT"
fi

if [ "$INCLUDE_ENV" = 1 ]; then
  echo "==> .env -> $ENV_OUT"
  cp -p .env "$ENV_PART"
  chmod 600 "$ENV_PART"
  mv "$ENV_PART" "$ENV_OUT"
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
