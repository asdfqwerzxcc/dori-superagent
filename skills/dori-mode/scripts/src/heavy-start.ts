// A probe binary that cannot be started is an unknown start time, never an exception out of the lock: unknown refuses.
const spawnStart = (argv: string[]) => {
  try {
    return Bun.spawnSync(argv, { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
};

export type LockProbe = (pid: number) => string | undefined;

/** The OS start time of a process, normalized to ISO, or undefined when the probe cannot answer. A reused pid starts
 * at a different time, which is how a lock left by an exited holder is told from one still held. */
export const processStart = (pid: number): string | undefined => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const win32 = process.platform === "win32";
  const argv = win32
    ? [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ]
    : ["ps", "-o", "lstart=", "-p", String(pid)];
  const r = spawnStart(argv);
  if (r === undefined || r.exitCode !== 0) return undefined;
  const ms = Date.parse(
    r.stdout
      .toString()
      .trim()
      .replace(/(\.\d{3})\d+/, "$1"),
  );
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
