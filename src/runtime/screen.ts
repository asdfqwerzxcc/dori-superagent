// omo's input box, read off the screen when a runtime's own status word lags (#62 on herdr, #178 on hc).

/** Recent lines read to look for the input box; the shared window for both runtimes and the inbox. */
export const SCREEN_LINES = 30;

/** A composer border: a dash run, sometimes sharing its row with the TPS footer omo redraws onto it. */
const BORDER = /─{10,}\s*$/;
const EMPTY_INPUT = /^❯\s*$/;
const BUSY = /esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
/** A running child task's row under the input box, led by its braille spinner; it does not push the box up (#263). */
const CHILD_ROW = /^\s*[\u2800-\u28FF] /;
const TURN = /esc to interrupt/i;
const WAITING_CHILDREN = /\bwaiting_children\b/;

/**
 * Lines the TUI redraws on its own (age, monitor duration, tips, model/cost, cwd). They never prove a turn, so they
 * neither hide an idle box nor count as output. The real footer wording drifts (`~/work`, then `~ •`; `effort medium`,
 * then `effort max`; `mem:agent`, then `mem:user`), so every family matches its whole shape, not one sample.
 */
const FOOTER: readonly RegExp[] = [
  /^\s*Tip\b/,
  /^\(OmO\)/,
  /\b\d+[smhd]\s+ago\b/,
  /\(\s*\d+h\s+\d+m\s*\)/,
  /\b(?:watching|monitors?)\b/i,
  /(?:^|[•\s])CH\d/,
  /\bCache hit\b|tok\/s/,
  /\$\d/,
  /\beffort\s+\w+\b/,
  /OmO Native|mem:/,
  /^\s*(?:~\s*•|~[/\\]|[A-Za-z]:[/\\])/,
];

const redrawn = (line: string): boolean => FOOTER.some((footer) => footer.test(line));

/** The screen's rows, trailing blanks dropped, and the index of its last `❯` line: the live composer, if one is there. */
function composerLines(screen: string): { readonly lines: readonly string[]; readonly input: number } {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  while (lines.at(-1) === "") lines.pop();
  return { lines, input: lines.findLastIndex((line) => line.startsWith("❯")) };
}

/**
 * True only when an omo screen positively shows its idle input at the bottom: an empty `❯` line between borders, with
 * nothing below the bottom border but redrawn footer lines and running child-task rows. A spinner or `esc to interrupt`
 * above the box, a draft, a dialog, or any unknown line below it is not idle. Stopgap for #62/#178: both runtimes
 * report an omo with live monitors as `working`.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const { lines, input } = composerLines(screen);
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!EMPTY_INPUT.test(lines[input] ?? "")) return false;
  if (!BORDER.test(lines[input - 1] ?? "") || !BORDER.test(lines[input + 1] ?? "")) return false;
  if (lines.slice(0, input).some((line) => BUSY.test(line))) return false;
  return lines.slice(input + 2).every((line) => line === "" || redrawn(line) || CHILD_ROW.test(line));
}

/** What the bottom of an omo screen says about taking a message now; `why` is the one-line reason the inbox logs. */
export type InputReadiness = { readonly ready: boolean; readonly why: string };

type Composer = { readonly lines: readonly string[]; readonly input: number };

/** The empty composer between its borders, or the one reason the screen does not show one. */
function emptyComposer(screen: string): Composer | { readonly why: string } {
  const { lines, input } = composerLines(screen);
  if (input < 1 || input + 1 >= lines.length) return { why: "no input box on screen" };
  if (!EMPTY_INPUT.test(lines[input] ?? "")) return { why: "the input box holds a draft" };
  if (!BORDER.test(lines[input - 1] ?? "")) return { why: "no border above the input box" };
  if (!BORDER.test(lines[input + 1] ?? "")) return { why: "no border under the input box" };
  return { lines, input };
}

/**
 * Whether an empty composer is on screen at all, whatever its state: a turn, a child or a monitor may own the rest of
 * the screen, but text typed into this composer is a follow-up. It is what the lead's busy delivery gates on; a dialog
 * or a draft has no empty composer and holds.
 */
export function omoComposerReady(screen: string): InputReadiness {
  const composer = emptyComposer(screen);
  return "why" in composer ? { ready: false, why: composer.why } : { ready: true, why: "empty composer on screen" };
}

/**
 * Whether omo's live composer can take a message now, not only between turns. While the agent waits on a background
 * child (the footer says `waiting_children`) omo keeps the composer under the child panel and queues text typed there
 * as a follow-up prompt, so the pane is reachable even though its status word stays `working`. A running turn
 * (`esc to interrupt`), a draft, a dialog, or an unknown line under the box without `waiting_children` is not ready:
 * the message waits, so a lane that is generating never gets a prompt mixed into its turn.
 */
export function omoInputReady(screen: string): InputReadiness {
  if (TURN.test(screen)) return { ready: false, why: "a turn is running (esc to interrupt)" };
  const composer = emptyComposer(screen);
  if ("why" in composer) return { ready: false, why: composer.why };
  const tail = composer.lines.slice(composer.input + 2);
  const below = tail.filter((line) => line !== "" && !redrawn(line));
  if (below.length === 0) return { ready: true, why: "idle input box" };
  if (!WAITING_CHILDREN.test(tail.join("\n"))) return { ready: false, why: "output below the input box" };
  return { ready: true, why: "input box live while waiting on background children" };
}

/**
 * True when the screen shows a gate-review child (its progress line names it). Reviews belong to `dori review` in its own
 * session, never to a child of the lead pane (Lee, 2026-11-24), so the inbox warns when it has to deliver past one.
 */
export function omoReviewChild(screen: string): boolean {
  return /\bgate review\b|omo-native-gate-reviewer/i.test(screen);
}
