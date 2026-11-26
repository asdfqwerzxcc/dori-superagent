import { readFileSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { shq } from "./delivery.ts";
import { memFreeMb, memFreePct } from "./host.ts";
import { type Exec, spawnExec } from "./runtime/exec.ts";
import { HcRuntime } from "./runtime/hc/index.ts";
import { OmoHostRuntime } from "./runtime/omo-host/index.ts";
import { HerdrRuntime } from "./runtime/herdr/index.ts";
import { Runtimes } from "./runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "./runtime/select.ts";
import { Store } from "./store.ts";
import { type HostLoad, KEY_RE, type Role, reservedKey } from "./store-types.ts";
import { Telemetry, type Usage } from "./telemetry.ts";
import { superviseHome, type SupervisedState } from "./supervisor-run.ts";

export { KEY_RE, reservedKey };

const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  /** The session runtimes: `default` opens new sessions, `for(ref)` reaches a stored one on its own runtime. */
  readonly runtimes: Runtimes;
  /** Which runtime new sessions open on, and why (`dori status` prints it). Throws when none can be chosen. */
  readonly choice: () => RuntimeChoice;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
  /** Waits at least `ms`; a fake Deps replaces it, so a re-check never really sleeps in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Starts the supervisors that are missing (`dori up`) or only reads their health; a fake Deps replaces it. */
  readonly supervise?: (home: string, opts?: { readonly startMissing?: boolean }) => Promise<SupervisedState>;
};

/** The runtime is chosen on first use, so commands that open or reach no session work without one installed. */
export const defaultDeps = (): Deps => {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  let store: Store | undefined;
  let chosen: RuntimeChoice | undefined;
  let runtimes: Runtimes | undefined;
  const choice = (): RuntimeChoice =>
    (chosen ??= readRuntimeChoice({ env: process.env, configPath: join(home, "config.json") }));
  return {
    // The store is created on first use: `dori doctor` must be able to report an unwritable or malformed home before
    // anything tries to create directories in it.
    get store() {
      store ??= new Store(home);
      return store;
    },
    get runtimes() {
      // The choice is made only when a NEW session is opened: a stored session's own runtime needs none.
      runtimes ??= new Runtimes(
        () => choice().kind,
        (k) =>
          k === "hc"
            ? new HcRuntime(spawnExec)
            : k === "omo-host"
              ? new OmoHostRuntime(spawnExec)
              : new HerdrRuntime(spawnExec, process.env["DORI_HERDR_SESSION"]),
      );
      return runtimes;
    },
    choice,
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    sleep: (ms) => Bun.sleep(ms),
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(home)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct(), memFreeMb: memFreeMb() }),
    usage: new Telemetry(home),
    supervise: (homePath, opts) => superviseHome(homePath, { startMissing: opts?.startMissing ?? false }),
  };
};

/** `DORI_PROMPTS_DIR` when set, else the repo's `prompts/`. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

export const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

/** The roles `dori role` registers by hand; `dori up` also registers the two loop sessions. */
export const ROLES: readonly Role[] = ["lead", "duty"];
