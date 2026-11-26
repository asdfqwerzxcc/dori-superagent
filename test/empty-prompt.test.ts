import { describe, expect, test } from "bun:test";
import { emptyPrompt } from "../src/runtime/pane-liveness.ts";

// D2 typing gate: only a bare prompt at the bottom is safe to type a command line into. Everything that could be a
// partial input - a draft, a continuation prompt, a border redrawn over the row - must fail.

describe("emptyPrompt accepts only a bare prompt as the last line", () => {
  for (const line of [
    "PS C:\\Users\\USER> ",
    "PS C:\\work\\repo>",
    "C:\\Users\\USER>",
    "user@host:~$",
    "root@host:/#",
    "~/work/project>",
    "$",
    "#",
    "%",
  ]) {
    test(`accepts ${JSON.stringify(line)}`, () => {
      expect(emptyPrompt(`old output\n${line}\n`)).toBe(true);
    });
  }

  for (const line of [
    ">> ", // PowerShell's continuation prompt: the previous line is still open
    "...", // Python/long-form continuation
    ">", // PowerShell PS2 too; a lone `>` is never a fresh prompt
    "PS C:\\Users\\USER> git status", // a draft after the prompt
    'PS C:\\Users\\USER> echo ">"', // a draft whose last character happens to be `>`
    "C:\\Users\\USER> dir >", // cmd draft ending in a redirect
    "user@host:~$ echo $", // a draft ending in the prompt character
    "user@host:~$ ls ~/x#",
    "PS C:\\Users\\USER>────────────────", // a border redrawn over the prompt row
    "── • Working (8s • esc to interrupt) ──",
    "❯",
    "",
  ]) {
    test(`refuses ${JSON.stringify(line)}`, () => {
      expect(emptyPrompt(`old output\n${line}\n`)).toBe(false);
    });
  }

  test("the prompt must be the last non-empty line, not an earlier one", () => {
    expect(emptyPrompt("PS C:\\Users\\USER>\nstill printing")).toBe(false);
  });
});
