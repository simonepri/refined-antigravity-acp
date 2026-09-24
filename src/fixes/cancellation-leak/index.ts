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
  STOP_REASONS,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
  type SessionUpdateParams,
} from "../../core/types.js";
import { extractSessionId, getFixData, setFixData } from "../../core/session-cache.js";

export const CANCELLATION_ERROR_REGEX =
  /^(?:context\s+canceled)?\s*The\s+request\s+was\s+cancelled\s+by\s+the\s+client\.?$/i;

export const CANCEL_PROMPT_SETTLED_KEY = "cancelPromptSettled";

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

interface CancellationState {
  activePrompts: Map<string, string | number>;
  cancelledPromptIds: Set<string | number>;
  cancelledSessions: Set<string>;
}

function handleOutboundPrompt(msg: AcpStreamMessage, state: CancellationState): void {
  const sessionId = extractSessionId(msg);
  const id = (msg as { id?: string | number }).id;
  if (sessionId && id !== undefined && id !== null) {
    state.activePrompts.set(sessionId, id);
    state.cancelledSessions.delete(sessionId);
  }
}

function handleOutboundCancel(
  msg: AcpStreamMessage,
  context: OutboundContext,
  state: CancellationState,
): void {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return;

  const promptId = state.activePrompts.get(sessionId);
  if (promptId === undefined) return;

  state.activePrompts.delete(sessionId);
  state.cancelledSessions.add(sessionId);
  state.cancelledPromptIds.add(promptId);

  const alreadySettled =
    context.session &&
    getFixData<string | number>(context.session, CANCEL_PROMPT_SETTLED_KEY) === promptId;

  if (alreadySettled) return;

  if (context.session) {
    setFixData(context.session, CANCEL_PROMPT_SETTLED_KEY, promptId);
  }

  const cancelResponse: AcpStreamMessage = {
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: STOP_REASONS.CANCELLED },
  };
  context.forwardInbound?.(cancelResponse);
}

function tryHandleCancelledPrompt(
  id: string | number,
  sessionId: string | undefined,
  state: CancellationState,
): boolean {
  if (!state.cancelledPromptIds.has(id)) return false;
  state.cancelledPromptIds.delete(id);
  if (sessionId) state.cancelledSessions.delete(sessionId);
  return true;
}

function handleInboundPromptId(
  msg: AcpStreamMessage,
  context: InboundContext,
  state: CancellationState,
): boolean {
  const id = (msg as { id?: string | number | null }).id;
  if (id === null || id === undefined) return false;

  const sessionId = extractSessionId(msg) ?? context.session?.sessionId;
  if (tryHandleCancelledPrompt(id, sessionId, state)) {
    return true;
  }

  if (sessionId && state.activePrompts.get(sessionId) === id) {
    state.activePrompts.delete(sessionId);
  }
  return false;
}

export function createCancellationLeakFix(): AcpFix {
  const state: CancellationState = {
    activePrompts: new Map(),
    cancelledPromptIds: new Set(),
    cancelledSessions: new Set(),
  };

  return {
    name: "cancellation-leak",
    description:
      "Suppresses raw upstream Go/Python cancellation error chunks and ensures prompt settlement during client interruptions",

    onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
        handleOutboundPrompt(msg, state);
      } else if (isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
        handleOutboundCancel(msg, context, state);
      }
      return msg;
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      if (handleInboundPromptId(msg, context, state)) {
        return [];
      }

      const sessionId = extractSessionId(msg) ?? context.session?.sessionId;
      if (sessionId && state.cancelledSessions.has(sessionId)) {
        if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
          return [];
        }
      }

      const text = extractMessageChunkText(msg);
      if (text && isCancellationText(text)) {
        return [];
      }

      return [msg];
    },

    dispose(): void {
      state.activePrompts.clear();
      state.cancelledPromptIds.clear();
      state.cancelledSessions.clear();
    },
  };
}

export const cancellationLeakFix = createCancellationLeakFix();
export const interruptionCleanupFix = cancellationLeakFix;
