import type { LinkStatus } from "./link-status.ts";

export type DeviceRow = {
  name: string;
  address: string;
  online: boolean;
  status?: LinkStatus;
  lastSeenAt?: number;
};

const lastAnswer = (row: DeviceRow): string => {
  if (row.status !== undefined) return row.status.now;
  return row.lastSeenAt === undefined ? "never" : new Date(row.lastSeenAt).toISOString();
};

/** One aligned row per device: offline devices keep the last answer they gave, never a blank. */
export const formatDeviceTable = (rows: readonly DeviceRow[]): string[] => {
  const header = ["NAME", "ADDRESS", "ONLINE", "CPU", "RAM", "SESSIONS", "LAST"];
  const cells = rows.map((row) => [
    row.name,
    row.address,
    row.online ? "online" : "offline",
    row.status?.cpuPct === null || row.status?.cpuPct === undefined ? "-" : `${row.status.cpuPct}%`,
    row.status?.memFreePct === null || row.status?.memFreePct === undefined ? "-" : `${row.status.memFreePct}% free`,
    row.status === undefined ? "-" : String(row.status.sessions),
    lastAnswer(row),
  ]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...cells.map((c) => (c[i] ?? "").length)));
  const pad = (row: readonly string[]): string =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? cell.length)))
      .join("  ")
      .trimEnd();
  return [pad(header), ...cells.map(pad)];
};
