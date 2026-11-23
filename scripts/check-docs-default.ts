// The class check for the lane-gate docs pass: no doc or prompt may present a bundle as the default landing path.
// A line that explicitly names the bundle as the non-default mode is allowed, so a correct "bundle is explicit" note
// can still contrast with the old framing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type DocsFinding = {
  readonly file: string;
  readonly line: number;
  readonly phrase: string;
  readonly text: string;
};

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "번들이 기본", pattern: /번들이\s*기본/ },
  { label: "번들을 기본", pattern: /번들을\s*기본/ },
  { label: "원격에 아무것도", pattern: /원격에\s*아무것도/ },
  { label: "포크로 푸시", pattern: /(?:포크|`?fork`?)\s*(?:로|에)?\s*(?:푸시|push)/i },
  { label: "우리 포크", pattern: /우리\s*포크/ },
  { label: "lead collects the bundle", pattern: /lead\s+collects\s+the\s+bundle/i },
];

const NON_DEFAULT = /명시적|선택|묶을 때만|only when|explicit|not the default|non-default|아니(?:라|다|고)|아닌/i;

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

export function checkDocsDefault(root: string): DocsFinding[] {
  const findings: DocsFinding[] = [];
  for (const file of ["docs", "prompts"].flatMap((dir) => markdown(root, dir))) {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      if (NON_DEFAULT.test(text)) return;
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(text)) findings.push({ file, line: index + 1, phrase: rule.label, text: text.trim() });
      }
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
