export const PLUGIN_POLL_MS = 5_000;
export const PLUGIN_RESTART_MS = 5_000;

export type Spawned = {
  readonly pid?: number | undefined;
  readonly on: (event: "exit", listener: (code: number | null) => void) => unknown;
};

export type PluginUnitOptions = {
  readonly name: string;
  readonly spawnChild: () => Spawned;
  readonly stopChild: (pid: number) => Promise<void>;
  readonly isEnabled: () => boolean;
  readonly onStart: (pid: number) => void;
  readonly onStop: () => void;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly restartMs?: number;
  readonly pollMs?: number;
};

/**
 * One plugin's slice of the supervisor: spawn it while state/plugins.json enables it, stop it when that changes, and
 * start it again `restartMs` after an exit. Each plugin gets its own loop, so one child's failure is only its own.
 */
export async function runPluginUnit(o: PluginUnitOptions): Promise<never> {
  const restartMs = o.restartMs ?? PLUGIN_RESTART_MS;
  const pollMs = o.pollMs ?? PLUGIN_POLL_MS;
  for (;;) {
    if (!o.isEnabled()) {
      await o.sleep(pollMs);
      continue;
    }
    const child = o.spawnChild();
    const pid = child.pid;
    if (pid === undefined) {
      o.log(`SUPERVISED ${o.name}_spawn_failed`);
      await o.sleep(restartMs);
      continue;
    }
    o.onStart(pid);
    let stopping = false;
    const watcher = setInterval(() => {
      if (stopping || o.isEnabled()) return;
      stopping = true;
      o.log(`SUPERVISED ${o.name}_stop`);
      void o.stopChild(pid);
    }, pollMs);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    clearInterval(watcher);
    o.onStop();
    o.log(`SUPERVISED ${o.name}_exit code=${code}`);
    await o.sleep(restartMs);
  }
}
