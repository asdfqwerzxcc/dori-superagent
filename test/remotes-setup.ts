import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteMachine } from "../src/remotes.ts";
import type { Exec } from "../src/runtime/exec.ts";

const homes: string[] = [];

/** A fresh DORI_HOME for one test, removed by `cleanupHomes`. */
export const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-remotes-"));
  homes.push(dir);
  return dir;
};

export const cleanupHomes = (): void => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const linux: RemoteMachine = {
  name: "box2",
  ssh: "user@192.168.0.12",
  repo: "~/.dori/src",
  os: "linux",
  temp: "/tmp",
};

export const windows: RemoteMachine = {
  name: "win",
  ssh: "lee@192.168.0.20",
  repo: "C:\\work\\dori repo",
  os: "windows",
  temp: "C:\\Users\\Public\\dori",
};

export const fake = (answers: (cmd: string) => { code: number; stdout: string; stderr: string }) => {
  const calls: { cmd: string; argv: readonly string[] }[] = [];
  const exec: Exec = async (cmd, argv) => {
    calls.push({ cmd, argv });
    return answers(cmd);
  };
  return { exec, calls };
};

export const sinks = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    printed: () => out.join(""),
    errors: () => err.join(""),
  };
};
