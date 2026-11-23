// The class check for the lane-gate docs pass: no doc or prompt may present a bundle as the default landing path or
// repeat a bundle-era workflow instruction. The exemption is scoped to the sentence around the forbidden phrase, so an
// unrelated "explicit"/"선택" elsewhere on a long line cannot hide a stale claim.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type DocsFinding = {
  readonly file: string;
  readonly line: number;
  readonly phrase: string;
  readonly text: string;
};

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "번들 MR 대상", pattern: /번들\s*MR\s*대상/ },
  { label: "git push fork main", pattern: /git\s+push\s+fork\s+main/i },
  { label: "번들 흐름이 켜진 뒤에는", pattern: /번들\s*흐름이\s*켜진\s*뒤에는/ },
  { label: "원격에 아무것도", pattern: /원격에\s*아무것도/ },
  { label: "번들 게이트 모드(현재 기본)", pattern: /번들\s*게이트\s*모드\s*\(\s*현재[^)]*기본/ },
  { label: "원격은 번들 MR 하나뿐", pattern: /원격(?:은|이)\s*번들\s*MR\s*(?:하나)?뿐/ },
  {
    label: "finished lanes are collected into a bundle",
    pattern: /finished\s+lanes\s+are\s+collected\s+into\s+a\s+bundle/i,
  },
  { label: "the bundle is the default", pattern: /bundle(?:s)?\s+(?:is|are)\s+the\s+default/i },
  { label: "lead collects the bundle", pattern: /lead\s+collects\s+the\s+bundle/i },
];

const MODE_PHRASE =
  /명시적\s*(?:묶음\s*)?모드|묶을\s*때만|only\s+when|explicit\s+mode|not\s+the\s+default|non-default|선택|아니(?:라|다|고)|아닌|아님/i;

const BOUNDARIES = [".", "。", "!", "?"] as const;
const sentenceAt = (text: string, at: number): string => {
  const before = Math.max(
    -1,
    ...BOUNDARIES.map((boundary) => text.lastIndexOf(boundary, at - 1)),
    text.lastIndexOf("\n", at - 1),
  );
  const after = Math.min(
    ...BOUNDARIES.map((boundary) => text.indexOf(boundary, at)).filter((index) => index >= 0),
    text.length,
  );
  return text.slice(before + 1, after === text.length ? text.length : after + 1);
};

const markdown = (root: string, dir: string): string[] => {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return markdown(root, rel);
      return entry.isFile() && entry.name.endsWith(".md") ? [rel] : [];
    })
    .sort();
};

const BUNDLE = /번들/g;

const pairsBundleDefault = (text: string): boolean => {
  for (const match of text.matchAll(BUNDLE)) {
    if (match.index === undefined) continue;
    const sentence = sentenceAt(text, match.index);
    if (!sentence.includes("기본")) continue;
    if (MODE_PHRASE.test(sentence)) continue;
    return true;
  }
  return false;
};

export function checkDocsDefault(root: string): DocsFinding[] {
  const findings: DocsFinding[] = [];
  for (const file of ["docs", "prompts"].flatMap((dir) => markdown(root, dir))) {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      let flagged = false;
      for (const rule of FORBIDDEN) {
        const pattern = new RegExp(
          rule.pattern.source,
          rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
        );
        for (const match of text.matchAll(pattern)) {
          if (match.index === undefined) continue;
          if (MODE_PHRASE.test(sentenceAt(text, match.index))) continue;
          findings.push({ file, line: index + 1, phrase: rule.label, text: text.trim() });
          flagged = true;
        }
      }
      if (!flagged && pairsBundleDefault(text))
        findings.push({ file, line: index + 1, phrase: "번들 + 기본", text: text.trim() });
    });
  }
  return findings;
}

if (import.meta.main) {
  const findings = checkDocsDefault(resolve(import.meta.dir, ".."));
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.phrase}: ${finding.text}`);
  if (findings.length > 0) process.exit(1);
  console.log("DOCS_DEFAULT_OK");
}
