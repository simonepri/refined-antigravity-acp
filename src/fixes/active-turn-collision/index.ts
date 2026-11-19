/**
 * Problem:
 * Sending a prompt request while an upstream agent turn is in progress (e.g. executing tool calls)
 * is rejected with a fatal error: `"A foreground turn is already active"`.
 *
 * Solution:
 * Queues in-flight user steering directives, classifies mid-turn inputs, and retries
 * rejected prompt requests once the active turn transitions to idle.
 */

import {
  ACP_METHODS,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type AcpStreamMessage,
  type AcpFix,
  type InboundContext,
} from "../../core/types.js";

import { repairOrphanedCheckpoints, DONE_CH_PANIC_MARKER } from "../orphaned-checkpoints/index.js";
import {
  extractSessionId,
  getSession,
  getOrCreateSession,
  getSessionIdForRequest,
  trackPendingRequestSession,
} from "../../core/session-cache.js";

export function stripSteeringPrefix(text: string): string {
  return text
    .replace(/(?:^|\n)\s*\[Mid-turn update\]:\s*/gi, "")
    .replace(/(?:\n*\(Important: [^)]+\)\.?)/gi, "");
}

export const FOREGROUND_TURN_ERROR_PATTERN = /foreground turn is already active/i;
export const DONE_CH_ERROR_PATTERN = new RegExp(DONE_CH_PANIC_MARKER, "i");
export const SESSION_NOT_FOUND_PATTERN = /session not found/i;
export const MAX_PROMPT_RETRIES = 5;
export const DEFAULT_PROMPT_RETRY_DELAY_MS = 500;

export interface UserSteeringOptions {
  delayMs?: number;
  maxRetries?: number;
}

interface PendingRetryItem {
  msg: AcpStreamMessage;
  attempts: number;
  timer?: NodeJS.Timeout | undefined;
  recycled?: boolean | undefined;
}

function parsePromptError(msg: AcpStreamMessage): { needsRecovery: boolean } | null {
  if (!("error" in msg) || !msg.error) return null;
  const text = JSON.stringify(msg.error);
  if (DONE_CH_ERROR_PATTERN.test(text) || SESSION_NOT_FOUND_PATTERN.test(text))
    return { needsRecovery: true };
  if (FOREGROUND_TURN_ERROR_PATTERN.test(text)) return { needsRecovery: false };
  return null;
}

async function handleSessionRecovery(
  pendingMsg: AcpStreamMessage,
  context: InboundContext,
): Promise<void> {
  const targetSessionId = extractSessionId(pendingMsg);
  if (!targetSessionId) return;
  repairOrphanedCheckpoints(targetSessionId);
  const session = getOrCreateSession(context.sessionCache, targetSessionId);
  session.needsRecycle = true;
  await context.triggerRecycle(session);
}

async function dispatchQueuedPrompt(
  msgId: string | number,
  pending: PendingRetryItem,
  context: InboundContext,
): Promise<void> {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  try {
    const sessionId = extractSessionId(pending.msg);
    const session = getSession(context.sessionCache, sessionId);
    if (session?.needsRecycle) {
      await context.triggerRecycle(session);
    }
    if (
      sessionId &&
      "id" in pending.msg &&
      pending.msg.id !== undefined &&
      pending.msg.id !== null
    ) {
      trackPendingRequestSession(context.sessionCache, pending.msg.id, sessionId);
    }
    await context.writeToChild(pending.msg);
  } catch (err) {
    console.error(`[refined-antigravity-acp] Failed to resend prompt ${msgId}:`, err);
  }
}

function schedulePromptRetry(
  msgId: string | number,
  pending: PendingRetryItem,
  delayMs: number,
  context: InboundContext,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pending.timer = setTimeout(() => {
    pending.timer = undefined;
    void dispatchQueuedPrompt(msgId, pending, context);
  }, delayMs);
  pending.timer.unref?.();
}

async function handlePromptRetryOrRecovery(
  msgId: string | number,
  pending: PendingRetryItem,
  needsRecovery: boolean,
  delayMs: number,
  maxRetries: number,
  context: InboundContext,
): Promise<boolean> {
  if (needsRecovery) {
    await handleSessionRecovery(pending.msg, context);
    if (pending.attempts >= MAX_PROMPT_RETRIES) {
      return false;
    }
    pending.attempts += 1;
    schedulePromptRetry(msgId, pending, 0, context);
    return true;
  }

  // If foreground turn collision persists, attempt to cancel any hanging upstream turn
  if (pending.attempts === 2) {
    const sessionId = extractSessionId(pending.msg);
    if (sessionId) {
      void context.writeToChild({
        jsonrpc: "2.0",
        id: `cancel_collision_${Date.now()}`,
        method: ACP_METHODS.SESSION_CANCEL,
        params: { sessionId },
      });
    }
  }

  // Foreground turn collision: never kill or recycle the healthy process while the turn is active!
  // Return false when maxRetries is exceeded so client receives the error and unfreezes.
  if (pending.attempts >= maxRetries) {
    return false;
  }

  pending.attempts += 1;
  schedulePromptRetry(msgId, pending, delayMs, context);
  return true;
}

function trackOutboundPrompt(
  msg: AcpStreamMessage,
  pendingPromptRetries: Map<string | number, PendingRetryItem>,
): void {
  if (isJsonRpcRequest(msg) && msg.method === ACP_METHODS.SESSION_PROMPT) {
    pendingPromptRetries.set(msg.id, {
      msg: structuredClone(msg),
      attempts: 0,
    });
  }
}

export const USER_STEERING_INSTRUCTIONS: readonly string[] = [
  "When receiving a mid-turn update, question, or redirection, acknowledge and address it directly in your response before proceeding or stopping.",
];

function cleanupPendingRetry(
  pendingPromptRetries: Map<string | number, PendingRetryItem>,
  msgId: string | number,
): void {
  const pending = pendingPromptRetries.get(msgId);
  if (pending?.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  pendingPromptRetries.delete(msgId);
}

function dispatchQueuedOnTurnCompletion(
  msg: AcpStreamMessage,
  pendingPromptRetries: Map<string | number, PendingRetryItem>,
  context: InboundContext,
): void {
  if (!isJsonRpcResponse(msg) || !("result" in msg) || !msg.result) return;
  const completedSessionId =
    getSessionIdForRequest(context.sessionCache, msg.id) ?? extractSessionId(msg);
  if (!completedSessionId) return;

  for (const [id, pending] of pendingPromptRetries.entries()) {
    if (id !== msg.id && extractSessionId(pending.msg) === completedSessionId) {
      void dispatchQueuedPrompt(id, pending, context);
      break;
    }
  }
}

async function handleInboundCollision(
  msg: AcpStreamMessage & { id: string | number },
  pending: PendingRetryItem,
  delayMs: number,
  maxRetries: number,
  context: InboundContext,
  pendingPromptRetries: Map<string | number, PendingRetryItem>,
): Promise<AcpStreamMessage[]> {
  const parsed = parsePromptError(msg);
  if (!parsed) {
    cleanupPendingRetry(pendingPromptRetries, msg.id);
    return [msg];
  }

  const retried = await handlePromptRetryOrRecovery(
    msg.id,
    pending,
    parsed.needsRecovery,
    delayMs,
    maxRetries,
    context,
  );
  if (!retried) {
    cleanupPendingRetry(pendingPromptRetries, msg.id);
    return [msg];
  }
  return [];
}

export function createActiveTurnCollisionFix(options?: UserSteeringOptions): AcpFix {
  const pendingPromptRetries = new Map<string | number, PendingRetryItem>();
  const delayMs = options?.delayMs ?? DEFAULT_PROMPT_RETRY_DELAY_MS;
  const maxRetries = options?.maxRetries ?? MAX_PROMPT_RETRIES;

  return {
    name: "active-turn-collision",
    description:
      "Handles mid-turn steering and retries prompts rejected due to active foreground turns",

    getSystemInstructions(): readonly string[] {
      return USER_STEERING_INSTRUCTIONS;
    },

    onOutbound: (msg: AcpStreamMessage): AcpStreamMessage => {
      trackOutboundPrompt(msg, pendingPromptRetries);
      return msg;
    },

    onInbound: async (
      msg: AcpStreamMessage,
      context: InboundContext,
    ): Promise<AcpStreamMessage[]> => {
      dispatchQueuedOnTurnCompletion(msg, pendingPromptRetries, context);
      if (!isJsonRpcResponse(msg)) return [msg];
      const pending = pendingPromptRetries.get(msg.id);
      if (!pending) return [msg];
      return handleInboundCollision(
        msg as AcpStreamMessage & { id: string | number },
        pending,
        delayMs,
        maxRetries,
        context,
        pendingPromptRetries,
      );
    },

    dispose: (): void => {
      for (const pending of pendingPromptRetries.values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
      }
      pendingPromptRetries.clear();
    },
  };
}

export const activeTurnCollisionFix = createActiveTurnCollisionFix();
export const createUserSteeringFix = createActiveTurnCollisionFix;
export const userSteeringFix = activeTurnCollisionFix;
export const createPromptRetryFix = createActiveTurnCollisionFix;
export const promptRetryFix = activeTurnCollisionFix;
