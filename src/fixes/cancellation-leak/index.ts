/**
 * Problem:
 * When a user cancels an in-flight turn via `session/cancel`, upstream `agy_acp_server`
 * leaks internal Go/Python cancellation error strings (`"context canceledThe request was cancelled by the client."`)
 * directly into assistant message stream chunks before terminating the turn.
 * Additionally, if a subsequent prompt is sent immediately after cancellation before upstream has finished
 * unwinding, raw agy fails or crashes with concurrent receive_steps errors.
 *
 * Solution:
 * Intercepts inbound `session/update` chunks matching upstream cancellation error strings and drops them,
 * preserves terminal `tool_call_update` status notifications so client UIs complete running tools,
 * waits for upstream's natural cancellation response with a safety timeout fallback, and queues any
 * subsequent outbound prompt until the previous cancellation has completely unwound.
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
import { extractSessionId } from "../../core/session-cache.js";

export const CANCELLATION_ERROR_REGEX =
  /^(?:context\s+canceled)?\s*The\s+request\s+was\s+cancelled\s+by\s+the\s+client\.?$/i;

export const CONCURRENT_RECEIVE_STEPS_REGEX =
  /^Agent connection was lost and could not be re-established:\s*Concurrent receive_steps\(\) calls are not supported on this connection\.?$/i;

export const DEFAULT_CANCELLATION_TIMEOUT_MS = 2500;

export function isCancellationText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    trimmed === "context canceled" ||
    trimmed === "The request was cancelled by the client." ||
    CANCELLATION_ERROR_REGEX.test(trimmed) ||
    CONCURRENT_RECEIVE_STEPS_REGEX.test(trimmed)
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

interface CancellingSession {
  promptId: string | number;
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
}

interface CancellationState {
  activePrompts: Map<string, string | number>;
  cancellingSessions: Map<string, CancellingSession>;
  suppressedLateResponseIds: Set<string | number>;
}

export interface CancellationOptions {
  timeoutMs?: number;
}

async function handleOutboundPrompt(
  msg: AcpStreamMessage,
  state: CancellationState,
): Promise<void> {
  const sessionId = extractSessionId(msg);
  const id = (msg as { id?: string | number }).id;
  if (sessionId) {
    const cancelling = state.cancellingSessions.get(sessionId);
    if (cancelling) {
      await cancelling.promise;
    }
    if (id !== undefined && id !== null) {
      state.activePrompts.set(sessionId, id);
    }
  }
}

function handleOutboundCancel(
  msg: AcpStreamMessage,
  context: OutboundContext,
  state: CancellationState,
  timeoutMs: number,
): void {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return;

  const promptId = state.activePrompts.get(sessionId);
  if (promptId === undefined) return;

  state.activePrompts.delete(sessionId);
  if (state.cancellingSessions.has(sessionId)) return;

  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });

  const timer = setTimeout(() => {
    const current = state.cancellingSessions.get(sessionId);
    if (current && current.promptId === promptId) {
      state.cancellingSessions.delete(sessionId);
      state.suppressedLateResponseIds.add(promptId);
      if (context.session) {
        context.session.needsRecycle = true;
      }
      const cancelResponse: AcpStreamMessage = {
        jsonrpc: "2.0",
        id: promptId,
        result: { stopReason: STOP_REASONS.CANCELLED },
      };
      context.forwardInbound?.(cancelResponse);
      resolveFn();
    }
  }, timeoutMs);
  timer.unref?.();

  state.cancellingSessions.set(sessionId, {
    promptId,
    timer,
    promise,
    resolve: resolveFn,
  });
}

function handleInboundPromptId(
  msg: AcpStreamMessage,
  _context: InboundContext,
  state: CancellationState,
): boolean {
  const id = (msg as { id?: string | number | null }).id;
  if (id === null || id === undefined) return false;

  if (state.suppressedLateResponseIds.has(id)) {
    state.suppressedLateResponseIds.delete(id);
    return true;
  }

  for (const [sessId, cancelling] of state.cancellingSessions.entries()) {
    if (cancelling.promptId === id) {
      clearTimeout(cancelling.timer);
      state.cancellingSessions.delete(sessId);
      cancelling.resolve();
      return false;
    }
  }

  for (const [sessId, promptId] of state.activePrompts.entries()) {
    if (promptId === id) {
      state.activePrompts.delete(sessId);
      break;
    }
  }

  return false;
}

function isSuppressedDuringCancellation(
  msg: AcpStreamMessage,
  sessionId: string | undefined,
  state: CancellationState,
): boolean {
  if (!sessionId || !state.cancellingSessions.has(sessionId)) return false;
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return false;
  const update = (msg.params as SessionUpdateParams | undefined)?.update;
  return update?.sessionUpdate !== SESSION_UPDATES.TOOL_CALL_UPDATE;
}

export function createCancellationLeakFix(options?: CancellationOptions): AcpFix {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS;
  const state: CancellationState = {
    activePrompts: new Map(),
    cancellingSessions: new Map(),
    suppressedLateResponseIds: new Set(),
  };

  return {
    name: "cancellation-leak",
    description:
      "Suppresses raw upstream Go/Python cancellation error chunks and ensures prompt settlement during client interruptions",

    async onOutbound(msg: AcpStreamMessage, context: OutboundContext): Promise<AcpStreamMessage> {
      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
        await handleOutboundPrompt(msg, state);
      } else if (isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
        handleOutboundCancel(msg, context, state, timeoutMs);
      }
      return msg;
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      if (handleInboundPromptId(msg, context, state)) {
        return [];
      }

      const sessionId = extractSessionId(msg) ?? context.session?.sessionId;
      if (isSuppressedDuringCancellation(msg, sessionId, state)) {
        return [];
      }

      const text = extractMessageChunkText(msg);
      if (text && isCancellationText(text)) {
        return [];
      }

      return [msg];
    },

    dispose(): void {
      for (const cancelling of state.cancellingSessions.values()) {
        clearTimeout(cancelling.timer);
        cancelling.resolve();
      }
      state.activePrompts.clear();
      state.cancellingSessions.clear();
      state.suppressedLateResponseIds.clear();
    },
  };
}

export const cancellationLeakFix = createCancellationLeakFix();
export const interruptionCleanupFix = cancellationLeakFix;
