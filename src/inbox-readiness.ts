import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { refText, sameSession } from "./refs.ts";
import { omoComposerReady, omoInputReady, omoReviewChild, SCREEN_LINES } from "./runtime/screen.ts";
import type { AgentStatus, SessionRef } from "./runtime/types.ts";

export type InboxReadiness = {
  readonly status: AgentStatus;
  /** Readiness came from the screen while the runtime still says working: hc must gate its send on that word. */
  readonly fromBusy: boolean;
};

/**
 * The inbox's readiness gate. A runtime word that lags the screen is replaced by what the screen shows: the lead's
 * composer takes a follow-up during any turn or child (r-extra1), and a lane's composer takes one only while it waits
 * (r-extra2 keeps lanes holding mid-turn). A failed read or an empty-inbox log is doubt: the messages stay queued.
 */
export async function inboxReadiness(
  d: Deps,
  ref: SessionRef,
  status: AgentStatus,
  waiting: number,
): Promise<InboxReadiness> {
  if (status !== "working") return { status, fromBusy: false };
  const lead = d.store.roles().lead;
  const isLead = lead !== undefined && sameSession(lead, ref);
  let screen: string;
  try {
    screen = await d.runtimes.for(ref).read(ref, SCREEN_LINES);
  } catch (e) {
    hold(ref, waiting, `screen read failed (${failureDetail(e)})`);
    return { status, fromBusy: false };
  }
  if (isLead) {
    // The human's only interface: omo queues text typed into the composer during a turn as a follow-up prompt, so a
    // busy lead still takes the message. A dialog or a draft is the one thing that holds it.
    const composer = omoComposerReady(screen);
    if (!composer.ready) {
      hold(ref, waiting, composer.why);
      return { status, fromBusy: false };
    }
    if (waiting > 0)
      process.stderr.write(`dori: inbox ${refText(ref)} delivering: working, injecting into the lead's input buffer\n`);
    if (omoReviewChild(screen))
      process.stderr.write(
        `dori: inbox ${refText(ref)} warning: a gate-review child is running in the lead pane; ` +
          "reviews belong to dori review in its own session, not a lead child\n",
      );
    return { status: "idle", fromBusy: true };
  }
  const ready = omoInputReady(screen);
  if (!ready.ready) {
    hold(ref, waiting, ready.why);
    return { status, fromBusy: false };
  }
  if (waiting > 0) process.stderr.write(`dori: inbox ${refText(ref)} delivering: working, ${ready.why}\n`);
  return { status: "idle", fromBusy: true };
}

function hold(ref: SessionRef, waiting: number, why: string): void {
  if (waiting > 0) process.stderr.write(`dori: inbox ${refText(ref)} queued: working, ${why}\n`);
}
