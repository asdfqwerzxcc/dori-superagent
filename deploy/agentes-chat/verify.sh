#!/usr/bin/env bash
# Verify this deploy package without Docker or WSL.
#
#   1. docker-compose.yml parses with Bun's YAML parser.
#   2. Every variable docker-compose.yml interpolates is in .env.example, and
#      every variable in .env.example is interpolated by the compose file
#      (COMPOSE_PROFILES excepted: Compose reads it itself).
#   3. backup.sh, restore.sh and verify.sh pass bash -n.
#
# Usage: ./verify.sh
# Exit 0 means all three checks passed.

set -euo pipefail

cd -- "$(dirname -- "$0")"

echo "== 1/3 YAML parse =="
bun -e '
const fs = require("node:fs");
const doc = Bun.YAML.parse(fs.readFileSync("docker-compose.yml", "utf8"));
const services = Object.keys(doc.services ?? {});
const volumes = Object.keys(doc.volumes ?? {});
if (services.length === 0) throw new Error("docker-compose.yml has no services");
console.log("OK services: " + services.join(", "));
console.log("OK volumes: " + volumes.join(", "));
'

echo
echo "== 2/3 compose <-> .env.example =="
bun -e '
const fs = require("node:fs");
const compose = fs.readFileSync("docker-compose.yml", "utf8");
const env = fs.readFileSync(".env.example", "utf8");

const interpolated = new Set();
for (const m of compose.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)) interpolated.add(m[1]);

const defined = new Set();
for (const line of env.split(/\r?\n/)) {
  const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (m) defined.add(m[1]);
}

const composeNative = new Set(["COMPOSE_PROFILES"]);
const missing = [...interpolated].filter((v) => !defined.has(v)).sort();
const unused = [...defined].filter((v) => !interpolated.has(v) && !composeNative.has(v)).sort();

console.log("compose interpolation vars: " + interpolated.size);
console.log(".env.example vars: " + defined.size + " (" + composeNative.size + " compose-native)");
if (missing.length) {
  console.error("MISSING from .env.example: " + missing.join(", "));
  process.exit(1);
}
if (unused.length) {
  console.error("UNUSED in docker-compose.yml: " + unused.join(", "));
  process.exit(1);
}
console.log("OK both directions match");

const required = ["POSTGRES_PASSWORD", "AGENTES_SECRET", "PUBLIC_URL"];
for (const v of required) {
  const m = new RegExp("^" + v + "=(.*)$", "m").exec(env);
  if (!m || m[1].trim() !== "") {
    console.error("NOT A PLACEHOLDER: " + v + " must be empty in .env.example");
    process.exit(1);
  }
}
console.log("OK required vars are empty placeholders: " + required.join(", "));

const img = /^AGENTES_IMAGE=(.*)$/m.exec(env);
if (!img || !/@sha256:[0-9a-f]{64}$/.test(img[1].trim())) {
  console.error("NOT PINNED: AGENTES_IMAGE must carry an @sha256 digest");
  process.exit(1);
}
console.log("OK AGENTES_IMAGE pinned by digest: " + img[1].trim());
'

echo
echo "== 3/3 bash -n =="
for f in backup.sh restore.sh verify.sh; do
  bash -n "$f"
  echo "OK $f"
done

echo
echo "ALL CHECKS PASSED"
