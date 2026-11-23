import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDocsDefault } from "../scripts/check-docs-default.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("docs default wording", () => {
  test("docs and prompts do not present a bundle as the default", () => {
    expect(checkDocsDefault(ROOT)).toEqual([]);
  });

  test("the guard catches a forbidden line and allows an explicit non-default line", () => {
    const root = mkdtempSync(join(tmpdir(), "dori-docs-default-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "docs", "bad.md"), "번들이 기본값이다.\n");
    writeFileSync(join(root, "prompts", "bad.md"), "lead collects the bundle\n");
    writeFileSync(join(root, "docs", "allowed.md"), "번들이 기본이 아니라 명시적 묶음 모드다.\n");
    const findings = checkDocsDefault(root);
    expect(findings.map((finding) => `${finding.file}:${finding.phrase}`)).toEqual([
      "docs/bad.md:번들이 기본",
      "prompts/bad.md:lead collects the bundle",
    ]);
  });
});
