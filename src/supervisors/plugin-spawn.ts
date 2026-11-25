import { spawn } from "node:child_process";

/** Start one plugin child for the supervisor; stdout and stderr go to the caller's log stream. */
export function spawnPluginChild(home: string, name: string, pluginRun: string, onLine: (chunk: Buffer) => void) {
  const child = spawn(process.execPath, [pluginRun, name], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: home,
    windowsHide: true,
    env: { ...process.env, DORI_HOME: home, DORI_VERIFY_PROMPT: "1" },
  });
  child.stdout?.on("data", onLine);
  child.stderr?.on("data", onLine);
  return child;
}
