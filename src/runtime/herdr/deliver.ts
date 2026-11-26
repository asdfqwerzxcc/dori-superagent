import type { AgentIdentity, DeliverOutcome, Key, SubmitResult } from "../types.ts";
import { emptyPrompt, type PaneTree } from "../pane-liveness.ts";
import { SCREEN_LINES } from "../screen.ts";
import { type HerdrCli, reasonOf, ToolError } from "./exec.ts";
import { probe } from "./probe.ts";

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
export const PASTE_SETTLE_MS = 400;
/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
export const ENTER_ATTEMPTS = 3;

export type Sleep = (ms: number) => Promise<void>;

const NO_AGENT: DeliverOutcome = { kind: "no-agent" };
/** How a failed lookup ends its stderr line on the delivery path: the message stays queued. */
const HOLDING = "holding delivery";
const ambiguous = (step: string, failure: unknown): DeliverOutcome => ({
  kind: "ambiguous",
  detail: `herdr ${step} failed: ${reasonOf(failure)}`,
  failure,
});
const identity = (agent: string | undefined, pgid: number | undefined): AgentIdentity => ({
  ...(agent !== undefined ? { agent } : {}),
  ...(pgid !== undefined ? { pgid } : {}),
});

/** A pane whose last visible line is a bare shell prompt has no agent in front, whatever herdr's status says. */
const BARE_PROMPT = /(?:^|\s)(?:PS\s+[A-Za-z]:\\[^>]*>|[$#>%])\s*$/;
const showsBarePrompt = (screen: string): boolean => {
  const lines = screen
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  const last = lines.at(-1) ?? "";
  return BARE_PROMPT.test(last);
};

/**
 * Delivers one message to the agent in a pane as a single argv element: nothing in it is ever expanded by a shell.
 * `no-agent`, having typed nothing: the pane has no running agent, and text typed into a bare shell runs as a command
 * (#66). `ambiguous`: the message may already be in the pane (#89) and must not be sent again as is. `typed`: the text
 * is in the agent's input and only the Enter that submits it is missing (#108 identity in `into`).
 */
export async function deliver(
  cli: HerdrCli,
  paneId: string,
  text: string,
  sleep: Sleep,
  tree?: PaneTree,
): Promise<DeliverOutcome> {
  // Probe first (#66): a gone pane or a shell in front gets nothing, whatever herdr's status word says. herdr types
  // whatever the status is (the caller decided), so the #62 screen read is skipped here.
  // A pane get that fails for any reason but not-found (a server that is down, a timeout) types nothing: the status is
  // unknown, so the caller keeps the message queued instead of seeing herdr's raw error.
  let first: Awaited<ReturnType<typeof probe>>;
  try {
    first = await probe(cli, paneId, { screenCheck: false, onFail: HOLDING, ...(tree === undefined ? {} : { tree }) });
  } catch (e) {
    process.stderr.write(`dori: herdr pane get failed for ${paneId} (${reasonOf(e)}); ${HOLDING}\n`);
    return { kind: "not-ready", status: "unknown" };
  }
  // D2: typing needs the pane's own process tree to prove a live process in it. A stale `working`, a childless shell
  // and an unreadable snapshot all type nothing; the message stays queued for a later tick.
  if (first.status === "gone" || first.shellInFront || first.liveness !== "alive") return NO_AGENT;
  try {
    await cli.call(["agent", "prompt", paneId, text]);
    // herdr accepts a prompt for a pane whose agent it still believes in, and types it into whatever is in front.
    // Opt-in (`DORI_VERIFY_PROMPT=1`) because it costs one screen read per delivery: a pane that answers with a bare
    // shell prompt has no agent, so the text may have run as a command and must not be sent again as is (#89).
    if (process.env["DORI_VERIFY_PROMPT"] === "1") {
      try {
        if (showsBarePrompt(await cli.read(paneId, SCREEN_LINES))) {
          return {
            kind: "ambiguous",
            detail: "herdr agent prompt left a bare shell prompt in the pane",
            failure: "herdr agent prompt left a bare shell prompt in the pane",
          };
        }
      } catch {
        // A screen read that fails proves nothing either way; the prompt was accepted, so keep the success.
      }
    }
    return { kind: "delivered" };
  } catch (e) {
    // herdr only accepts `agent prompt` for agents it started itself (`herdr agent start`); an omo launched
    // with `pane run` is detected but refused. Fall back to typing the text and pressing Enter.
    // Match herdr's own output, never e.message: that carries argv, which includes the delivered text.
    // Any other failure (a timeout, say) may come after herdr handed the prompt over: it is ambiguous.
    if (!(e instanceof ToolError) || !/agent_not_ready/.test(e.result.stderr || e.result.stdout))
      return ambiguous("agent prompt", e);
    // agent_not_ready also covers an agent that exited and left a shell in front: typing would run the text there.
    // Re-read right before typing (#66, D2): only a pane whose own tree proves a live process gets keystrokes.
    const again = await probe(cli, paneId, {
      screenCheck: false,
      onFail: HOLDING,
      ...(tree === undefined ? {} : { tree }),
    });
    if (again.status === "shell" || again.status === "gone" || again.shellInFront) return NO_AGENT;
    if (again.liveness !== "alive") return NO_AGENT;
    // A multi-line paste swallows the Enter that follows it, so type the message as one line.
    // A failed send-text may still have typed some or all of it: ambiguous as well.
    try {
      await cli.call(["pane", "send-text", paneId, text.trim().replace(/\s*\n\s*/g, " / ")]);
    } catch (err) {
      return ambiguous("pane send-text", err);
    }
    await sleep(PASTE_SETTLE_MS);
    const missed = await pressEnter(cli, paneId);
    return missed
      ? { kind: "typed", into: identity(again.agent, again.pgid), failure: missed.failure }
      : { kind: "delivered" };
  }
}

/**
 * Submits text that an earlier deliver typed into `typedInto` but could not submit: presses only Enter, never types
 * the text again. `changed`, pressing nothing: herdr sees no agent in the pane, or a different one (another name or
 * foreground process group), so the typed text is not in this input (#108). `wait`, pressing nothing: the agent is
 * still reported but a shell is in front (suspended with Ctrl+Z, #66/#69), or the lookup failed. Throws herdr's
 * error when every Enter failed.
 */
export async function submitTyped(
  cli: HerdrCli,
  paneId: string,
  typedInto: AgentIdentity,
  tree?: PaneTree,
): Promise<SubmitResult> {
  // submitTyped holds the Enter of an earlier delivery, so a failed lookup is reported as holding that delivery.
  const p = await probe(cli, paneId, { screenCheck: false, onFail: HOLDING, ...(tree === undefined ? {} : { tree }) });
  if (p.status === "gone") return "wait";
  if (p.status === "shell") return "changed";
  if (p.shellInFront) return "wait";
  // D2: an unreadable snapshot cannot prove the agent is still there, and Enter at a dead shell's prompt runs its line.
  if (p.liveness !== "alive") return "wait";
  if (typedInto.agent !== undefined && p.agent !== typedInto.agent) return "changed";
  if (typedInto.pgid !== undefined && p.pgid !== typedInto.pgid) return "changed";
  const missed = await pressEnter(cli, paneId);
  if (missed) throw missed.failure;
  return "submitted";
}

/** The text is already in the pane: retry only the Enter, so a flaky key press never re-types the message. */
async function pressEnter(cli: HerdrCli, paneId: string): Promise<{ readonly failure: unknown } | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      await cli.call(["pane", "send-keys", paneId, "enter"]);
      return undefined;
    } catch (failure) {
      if (attempt >= ENTER_ATTEMPTS) return { failure };
    }
  }
}

/**
 * The operator's explicit `dori send --to-shell`: types text + Enter into a pane that has no agent, and only at the
 * same proof `dori up` needs — the pane's tree shows a childless shell and its last screen line is an empty prompt.
 * Anything else (a live child, a draft, a prompt redrawn over, an unreadable snapshot or screen) types nothing.
 */
export async function typeIntoShell(cli: HerdrCli, paneId: string, text: string, tree?: PaneTree): Promise<boolean> {
  const p = await probe(cli, paneId, { screenCheck: false, onFail: HOLDING, ...(tree === undefined ? {} : { tree }) });
  if (p.status !== "shell" || p.liveness !== "exited") return false;
  let screen: string;
  try {
    screen = await cli.read(paneId, SCREEN_LINES);
  } catch {
    return false;
  }
  if (!emptyPrompt(screen)) return false;
  await cli.call(["pane", "send-text", paneId, text]);
  await cli.call(["pane", "send-keys", paneId, "enter"]);
  return true;
}

export async function keys(cli: HerdrCli, paneId: string, pressed: readonly Key[]): Promise<void> {
  for (const key of pressed) await cli.call(["pane", "send-keys", paneId, key]);
}
