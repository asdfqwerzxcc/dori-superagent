import { isRecord } from "./protocol.ts";
import type { SenpiDelta, SenpiFailure, SenpiMessage, SenpiTextBlock, SenpiTurnMessage } from "./senpi-types.ts";

export const responseOf = (
  message: SenpiMessage,
): { readonly id: string; readonly ok: boolean; readonly command: unknown; readonly detail: string } | null => {
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const detail = typeof message.error === "string" && message.error.trim() ? message.error : "unknown error";
  return { id: String(id), ok: message.success === true, command: message.command, detail };
};

export const textDelta = (message: SenpiMessage): string | null => {
  const event = message.assistantMessageEvent as SenpiDelta | undefined;
  if (!isRecord(event) || event.type !== "text_delta" || typeof event.delta !== "string" || !event.delta) return null;
  return event.delta;
};

export const assistantText = (message: SenpiMessage): string | null => {
  const whole = message.message as SenpiTurnMessage | undefined;
  if (!isRecord(whole) || whole.role !== "assistant") return null;
  if (typeof whole.content === "string") return whole.content || null;
  if (!Array.isArray(whole.content)) return null;
  let text = "";
  for (const block of whole.content as readonly SenpiTextBlock[]) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text || null;
};

export const agentEndState = (message: SenpiMessage): { readonly aborted: boolean; readonly failure: string | null } => {
  const failure = message.failure as SenpiFailure | undefined;
  let reason: string | null = null;
  if (isRecord(failure)) {
    reason = typeof failure.reason === "string" ? failure.reason : typeof failure.category === "string" ? failure.category : "unknown";
  }
  return { aborted: message.aborted === true, failure: reason };
};
