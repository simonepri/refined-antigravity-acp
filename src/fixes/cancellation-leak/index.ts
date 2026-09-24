/**
 * Problem:
 * When a user cancels an in-flight turn via `session/cancel`, upstream `agy_acp_server`
 * leaks internal Go/Python cancellation error strings (`"context canceledThe request was cancelled by the client."`)
 * directly into assistant message stream chunks before terminating the turn.
 *
 * Solution:
 * Intercepts inbound `session/update` chunks matching upstream cancellation error strings
 * and silently drops them, ensuring the editor message feed remains clean.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type SessionUpdateParams,
} from "../../core/types.js";

export const CANCELLATION_ERROR_REGEX =
  /^(?:context\s+canceled)?\s*The\s+request\s+was\s+cancelled\s+by\s+the\s+client\.?$/i;

export function isCancellationText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    trimmed === "context canceled" ||
    trimmed === "The request was cancelled by the client." ||
    CANCELLATION_ERROR_REGEX.test(trimmed)
  );
}

function extractContentText(content: unknown): string | null {
  if (Array.isArray(content)) {
    let result = "";
    for (const b of content) {
      if (typeof b?.text === "string") result += b.text;
    }
    return result.length > 0 ? result : null;
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

export function extractMessageChunkText(msg: AcpStreamMessage): string | null {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return null;
  const update = (msg.params as SessionUpdateParams | undefined)?.update;
  if (update?.sessionUpdate !== SESSION_UPDATES.AGENT_MESSAGE_CHUNK || !update.content) return null;
  return extractContentText(update.content);
}

export const cancellationLeakFix: AcpFix = {
  name: "cancellation-leak",
  description:
    "Suppresses raw upstream Go/Python cancellation error chunks during client interruptions",

  onInbound(msg: AcpStreamMessage): AcpStreamMessage[] {
    const text = extractMessageChunkText(msg);
    if (text && isCancellationText(text)) {
      return [];
    }
    return [msg];
  },
};

export const interruptionCleanupFix = cancellationLeakFix;
