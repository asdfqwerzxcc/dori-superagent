import { AcpError } from "./protocol.ts";

const FORBIDDEN_PROVIDERS = new Set(["goat", "dori"]);

export const assertLocalModel = (model: string): void => {
  const trimmed = model.trim();
  if (!trimmed) throw new AcpError("defaultModel is empty; set one in ~/.dori/config.json");
  const provider = (trimmed.split("/")[0] ?? "").trim().toLowerCase();
  if (FORBIDDEN_PROVIDERS.has(provider)) {
    throw new AcpError(
      `refusing GOAT provider "${provider}" as the ACP backend; ACP only delegates to a local senpi process`,
    );
  }
};

export const resolveSenpiCommand = (env: Record<string, string | undefined> = process.env): string[] => {
  const raw = env["DORI_ACP_SENPI"]?.trim();
  if (!raw) return ["senpi"];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) {
      return parsed as string[];
    }
  } catch {
    return [raw];
  }
  return [raw];
};

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const killProcessTree = async (pid: number): Promise<void> => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
      await killer.exited;
    } catch {
      return;
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await Bun.sleep(200);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
};

export const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

export const snippet = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 400);
