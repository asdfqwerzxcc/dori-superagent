import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LeadSwapOptions } from "../src/lead-swap.ts";
import type { Probe } from "../src/runtime/types.ts";
import type { Proc } from "../src/supervisor-run.ts";
import { href } from "./fake.ts";

export const promptText = "You are the LEAD session of a dori harness.";
export const engineLine = "omo 5.1.81 (engine: senpi 2026.11.19-5)";

export const captureStdout = async (run: () => Promise<number>): Promise<{ code: number; out: string }> => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  try {
    return { code: await run(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
};

/** The ensure-up shape: `omo.exe -> node omo.js -> bun omo.js -> senpi cli`, with no `--session` anywhere. */
export const rowsFor = (prompt: string): Proc[] => [
  { pid: 100, command: "powershell.exe -NoExit", parent: 1 },
  {
    pid: 26976,
    command: `"C:\\Users\\USER\\.bun\\bin\\omo.exe" --append-system-prompt "${prompt}"`,
    parent: 100,
  },
  {
    pid: 25176,
    command: `node "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --append-system-prompt "${prompt}"`,
    parent: 26976,
  },
  {
    pid: 2012,
    command: `bun "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --append-system-prompt "${prompt}"`,
    parent: 25176,
  },
  {
    pid: 336,
    command: `bun "C:\\Users\\USER\\node_modules\\senpi\\dist\\bundle\\cli.js" --append-system-prompt "${prompt}"`,
    parent: 2012,
  },
  { pid: 400, command: "powershell.exe -NoExit", parent: 1 },
  {
    pid: 500,
    command: 'node "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --append-system-prompt "C:\\duty.md"',
    parent: 400,
  },
  {
    pid: 600,
    command: 'node "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --session "C:\\lane.jsonl"',
    parent: 1,
  },
];

export const shellOnly: Proc[] = [{ pid: 100, command: "powershell.exe -NoExit", parent: 1 }];

export const scratch = (): { home: string; prompt: string; session: string } => {
  const home = mkdtempSync(join(tmpdir(), "dori-lead-swap-"));
  const prompt = join(home, "lead.md");
  mkdirSync(dirname(prompt), { recursive: true });
  writeFileSync(prompt, promptText);
  const session = join(home, "session.jsonl");
  writeFileSync(session, '{"type":"session"}\n');
  return { home, prompt, session };
};

export type Fixture = {
  readonly prompt: string;
  readonly session: string;
  readonly list: () => Promise<readonly Proc[] | undefined>;
  readonly probe: () => Promise<Probe>;
  readonly kill?: (pid: number) => Promise<void>;
  readonly typeShell: (text: string) => Promise<boolean>;
  readonly version: () => Promise<string | undefined>;
};

export const options = (f: Fixture): { opts: LeadSwapOptions; lines: string[] } => {
  const lines: string[] = [];
  let clock = 0;
  return {
    lines,
    opts: {
      pane: href("w1:p1"),
      agentCmd: "omo",
      session: f.session,
      promptPath: f.prompt,
      sessionsRoot: join(tmpdir(), "dori-lead-swap-sessions"),
      dryRun: false,
      force: true,
      drainMs: 0,
      deathMs: 5000,
      launchMs: 5000,
      pollMs: 1,
      platform: "win32",
      list: f.list,
      probe: f.probe,
      kill: f.kill ?? (async () => {}),
      typeShell: f.typeShell,
      version: f.version,
      runtimeBuild: () => "7e6f2769a7b6b23a",
      sleep: async () => {},
      now: () => (clock += 1000),
      log: (line) => lines.push(line),
    },
  };
};
