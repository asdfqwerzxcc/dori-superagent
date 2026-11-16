import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginCtx, PluginStatusCtx } from "./plugin.ts";

const AT_HOUR = Number(process.env["UPDATECHECK_AT_HOUR"] ?? 4);
const TICK_MS = 300_000;

const nextPath = (home: string): string => join(home, "state", "update-check-next");
const logPath = (home: string): string => join(home, "state", "update-check.log");
const cliPath = (): string => join(import.meta.dir, "..", "cli.ts");

function log(home: string, line: string): void {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    mkdirSync(join(home, "state"), { recursive: true });
    appendFileSync(logPath(home), `${stamp} UPDATECHECK ${line}\n`);
  } catch {}
}

type Spawned = { readonly code: number; readonly out: string; readonly err: string };

async function run(cwd: string, argv: readonly string[], env?: Record<string, string>): Promise<Spawned> {
  const p = Bun.spawn([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

const firstLine = (s: string, max = 140): string => s.trim().split("\n")[0]?.slice(0, max) ?? "";

async function notify(ctx: PluginCtx, text: string): Promise<void> {
  const send = await run(join(ctx.home, "src"), [process.execPath, cliPath(), "send", "lead", "--text", text]);
  log(ctx.home, `notified code=${send.code} ${firstLine(send.out || send.err, 80)}`);
}

async function checkRepo(ctx: PluginCtx): Promise<void> {
  const repo = join(ctx.home, "src");
  const fetched = await run(repo, ["git", "fetch", "origin", "--quiet"]);
  if (fetched.code !== 0) {
    log(ctx.home, `fetch_failed ${firstLine(fetched.err, 120)}`);
    return;
  }
  const behind = await run(repo, ["git", "rev-list", "--count", "HEAD..origin/main"]);
  const n = Number(behind.out.trim());
  if (!Number.isFinite(n)) {
    log(ctx.home, `count_failed ${firstLine(behind.err, 120)}`);
    return;
  }
  if (n <= 0) {
    log(ctx.home, "up_to_date");
    return;
  }
  const subjects = await run(repo, ["git", "log", "--format=%h %s", "-n", "5", "HEAD..origin/main"]);
  const head = subjects.out.trim().split("\n").slice(0, 5).join("\n");
  log(ctx.home, `behind ${n}`);
  const text = [
    `[UPDATE] dori-superagent: origin/main이 ${n}커밋 앞서 있다.`,
    head,
    "승인하면 병합하고 검증한 뒤 루프를 재시작한다.",
  ].join("\n");
  await notify(ctx, text);
}

async function installedVersion(pkg: string): Promise<string> {
  try {
    const j = (await Bun.file(
      join(homedir(), ".bun", "install", "global", "node_modules", pkg, "package.json"),
    ).json()) as { version?: unknown };
    return String(j.version ?? "");
  } catch {
    return "";
  }
}

async function latestVersion(pkg: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, {
      headers: { "User-Agent": "dori-update-check" },
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { version?: unknown };
    return String(j.version ?? "");
  } catch {
    return "";
  }
}

async function changelog(from: string, to: string): Promise<string> {
  const repo = "code-yeongyu/oh-my-openagent";
  for (const tag of [`v${to}`, to]) {
    for (const old of [`v${from}`, from]) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/compare/${old}...${tag}`, {
          headers: { "User-Agent": "dori-update-check", Accept: "application/vnd.github+json" },
        });
        if (!res.ok) continue;
        const j = (await res.json()) as { commits?: { commit?: { message?: string } }[] };
        const lines = (j.commits ?? []).map((c) => (c.commit?.message ?? "").split("\n")[0] ?? "");
        if (lines.length === 0) return "(변경 커밋 없음)";
        return lines
          .slice(0, 12)
          .map((l) => `- ${l.slice(0, 90)}`)
          .join("\n");
      } catch {}
    }
  }
  return "(체인지로그 조회 실패)";
}

async function installLatest(ctx: PluginCtx, pkg: string, want: string, have: string): Promise<string> {
  const entry = join(homedir(), ".bun", "install", "global", "node_modules", "omo-ai", "bin", "omo.js");
  const install = await run(join(ctx.home, "src"), ["bun", "add", "-g", `${pkg}@${want}`], {
    BUN_INSTALL: join(homedir(), ".bun"),
  });
  if (install.code !== 0) {
    log(ctx.home, `install_failed ${pkg}@${want} ${firstLine(install.err || install.out)}`);
    return `install_failed ${pkg}@${want}`;
  }
  const verify = await run(join(ctx.home, "src"), [process.execPath, entry, "--version"]);
  if (verify.code !== 0) {
    log(ctx.home, `verify_failed ${pkg}@${want} ${firstLine(verify.err || verify.out)}`);
    if (have)
      await run(join(ctx.home, "src"), ["bun", "add", "-g", `${pkg}@${have}`], {
        BUN_INSTALL: join(homedir(), ".bun"),
      });
    log(ctx.home, `rollback ${pkg}@${have}`);
    return `verify_failed rollback_to ${have}`;
  }
  const now = firstLine(verify.out || verify.err, 80);
  log(ctx.home, `installed ${pkg}@${want} verified="${now}"`);
  const diff = await changelog(have, want);
  return `installed ${pkg} ${have} -> ${want} (${now})\n변경점:\n${diff}`;
}

async function checkPackages(ctx: PluginCtx): Promise<void> {
  const behind: string[] = [];
  for (const pkg of ["omo-ai", "@code-yeongyu/senpi"]) {
    const have = await installedVersion(pkg);
    const want = await latestVersion(pkg);
    if (have && want && have !== want) behind.push(`${pkg} ${have} -> ${want}`);
  }
  if (behind.length === 0) {
    log(ctx.home, "packages_up_to_date");
    return;
  }
  log(ctx.home, `packages_behind ${behind.join(", ")}`);
  const want = await latestVersion("omo-ai");
  const have = await installedVersion("omo-ai");
  const text = [
    `[UPDATE] 최신이 아니다: ${behind.join(", ")}`,
    "omo-ai는 무중단 규칙대로 '설치만' 진행한다 — 실행 중 세션은 런타임 스냅샷을 쓰므로 끊기지 않고, 새 세션이 새 버전을 잡는다.",
    "senpi는 자동 설치하지 않는다 — omo가 엔진 버전을 고정하므로 따로 갈면 조합이 깨진다. 알림만 남긴다.",
  ].join("\n");
  await notify(ctx, text);
  if (want && have && want !== have) {
    const result = await installLatest(ctx, "omo-ai", want, have);
    await notify(ctx, `[UPDATE] ${result}`);
  }
}

function nextAt(now: number, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function readTarget(home: string): number | undefined {
  try {
    const n = Number(readFileSync(nextPath(home), "utf8").trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** True when the 04:00 slot has passed and today's run is not on file; the next slot is written before returning. */
function due(home: string, now: number): boolean {
  const target = readTarget(home);
  if (target === undefined) {
    writeFileSync(nextPath(home), String(nextAt(now, AT_HOUR)));
    return false;
  }
  if (now < target) return false;
  writeFileSync(nextPath(home), String(nextAt(now, AT_HOUR)));
  return true;
}

const hhmm = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function status(c: PluginStatusCtx): string {
  const target = readTarget(c.home);
  if (target === undefined) return `next ${String(AT_HOUR).padStart(2, "0")}:00`;
  return c.at >= target ? "due" : `next ${hhmm(target)}`;
}

let immediateDone = false;

export const updateCheckPlugin: Plugin = {
  name: "update-check",
  intervalMs: TICK_MS,
  async run(ctx) {
    mkdirSync(ctx.stateDir, { recursive: true });
    const immediate = process.env["UPDATECHECK_NOW"] === "1" && !immediateDone;
    immediateDone = true;
    if (!immediate && !due(ctx.home, ctx.now())) return;
    await checkRepo(ctx).catch((e) => log(ctx.home, `error ${String(e).slice(0, 160)}`));
    await checkPackages(ctx).catch((e) => log(ctx.home, `error ${String(e).slice(0, 160)}`));
  },
  status,
};
