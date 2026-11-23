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

  test("every forbidden wording is caught and only a local explicit-mode phrase is allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "dori-docs-default-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    const put = (path: string, text: string) => writeFileSync(join(root, path), text);
    put("docs/bad-default-en.md", "The bundle is the default landing path.\n");
    put("docs/bad-default.md", "번들이 기본값이다.\n");
    put("docs/bad-english.md", "finished lanes are collected into a bundle\n");
    put("docs/bad-gate.md", "번들 게이트 모드(현재 dori 기본)\n");
    put("docs/bad-natural.md", "번들은 기본값이다.\n");
    put("docs/bad-remote.md", "원격은 번들 MR 하나뿐\n");
    put("docs/allowed.md", "번들이 기본이 아니라 명시적 묶음 모드다.\n");
    put("docs/double.md", "번들이 기본이 아니라 명시적 묶음 모드다. 또한 번들이 기본이다.\n");
    put("docs/mixed.md", "번들이 기본값이다. 이 문서는 명시적 모드를 설명한다.\n");
    put("prompts/bad.md", "lead collects the bundle\n");
    const findings = checkDocsDefault(root);
    expect(findings.map((finding) => `${finding.file}:${finding.phrase}`)).toEqual([
      "docs/bad-default-en.md:the bundle is the default",
      "docs/bad-default.md:번들은 기본",
      "docs/bad-english.md:finished lanes are collected into a bundle",
      "docs/bad-gate.md:번들 게이트 모드(현재 기본)",
      "docs/bad-natural.md:번들은 기본",
      "docs/bad-remote.md:원격은 번들 MR 하나뿐",
      "docs/double.md:번들은 기본",
      "docs/mixed.md:번들은 기본",
      "prompts/bad.md:lead collects the bundle",
    ]);
  });
});
