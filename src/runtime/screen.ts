// omo's idle input box, read off the screen when a runtime's own status word lags (#62 on herdr, #178 on hc).

/** Recent lines read to look for the idle box; the shared window for both runtimes and the inbox. */
export const SCREEN_LINES = 30;

const INPUT_RULE = /^─{10,}$/;
const EMPTY_INPUT = /^❯\s*$/;
const BUSY = /esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/** Lines the TUI redraws on its own (age, monitor duration, tips, model/cost); they never prove a turn. */
const FOOTER: readonly RegExp[] = [
  /^\s*Tip\b/,
  /\b\d+[smhd]\s+ago\b/,
  /\(\s*\d+h\s+\d+m\s*\)/,
  /\b(?:watching|monitors?)\b/i,
  /(?:^|[•\s])CH\d/,
  /\bCache hit\b|tok\/s/,
  /\$\d/,
  /\beffort\s+(?:low|medium|high)\b/,
  /OmO Native|mem:agent/,
  /^~[/\\]|^[A-Za-z]:[/\\]/,
];

/**
 * True only when an omo screen positively shows its idle input at the bottom: an empty `❯` line between rules, with
 * nothing below the bottom rule but redrawn footer lines. A spinner, `esc to interrupt`, a draft, or any unknown line
 * below the box is not idle. Stopgap for #62/#178: both runtimes report an omo with live monitors as `working`.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt") || BUSY.test(screen)) return false;
  const lines = screen
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !FOOTER.some((footer) => footer.test(line)));
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!EMPTY_INPUT.test(lines[input] ?? "")) return false;
  if (!INPUT_RULE.test(lines[input - 1] ?? "") || !INPUT_RULE.test(lines[input + 1] ?? "")) return false;
  return input + 2 === lines.length;
}
