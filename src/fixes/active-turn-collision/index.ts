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
  type AcpStreamMessage,
  type AcpFix,
  type InboundContext,
} from "../../core/types.js";

import { repairOrphanedCheckpoints, DONE_CH_PANIC_MARKER } from "../orphaned-checkpoints/index.js";
import {
  extractSessionId,
  getSession,
  getOrCreateSession,
  trackPendingRequestSession,
} from "../../core/session-cache.js";

export function stripSteeringPrefix(text: string): string {
  return text
    .replace(/(?:^|\n)\s*\[Mid-turn update\]:\s*/gi, "")
    .replace(/(?:\n*\(Important: [^)]+\)\.?)/gi, "");
}

export const FOREGROUND_TURN_ERROR_PATTERN = /foreground turn is already active/i;
export const DONE_CH_ERROR_PATTERN = new RegExp(DONE_CH_PANIC_MARKER, "i");
export const MAX_PROMPT_RETRIES = 5;
export const DEFAULT_PROMPT_RETRY_DELAY_MS = 500;

export interface UserSteeringOptions {
  delayMs?: number;
  maxRetries?: number;
}

interface PendingRetryItem {
  msg: AcpStreamMessage;
  attempts: number;
}

function parsePromptError(msg: AcpStreamMessage): { isDoneCh: boolean } | null {
  if (!("error" in msg) || !msg.error || typeof msg.error.message !== "string") return null;
  const text = msg.error.message;
  if (DONE_CH_ERROR_PATTERN.test(text)) return { isDoneCh: true };
  if (FOREGROUND_TURN_ERROR_PATTERN.test(text)) return { isDoneCh: false };
  return null;
}

async function handleDoneChRecovery(
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

function schedulePromptRetry(
  msgId: string | number,
  pending: PendingRetryItem,
  delayMs: number,
  context: InboundContext,
): void {
  const retryTimer = setTimeout(async () => {
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
  }, delayMs);
  retryTimer.unref?.();
}

export const USER_STEERING_INSTRUCTIONS: readonly string[] = [
  "When receiving a mid-turn update, question, or redirection, acknowledge and address it directly in your response before proceeding or stopping.",
];

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
      if (isJsonRpcRequest(msg) && msg.method === ACP_METHODS.SESSION_PROMPT) {
        pendingPromptRetries.set(msg.id, {
          msg: structuredClone(msg),
          attempts: 0,
        });
      }
      return msg;
    },

    onInbound: async (
      msg: AcpStreamMessage,
      context: InboundContext,
    ): Promise<AcpStreamMessage[]> => {
      if (!("id" in msg) || msg.id === null || msg.id === undefined) return [msg];
      const pending = pendingPromptRetries.get(msg.id);
      if (!pending) return [msg];

      const parsed = parsePromptError(msg);
      if (!parsed) {
        pendingPromptRetries.delete(msg.id);
        return [msg];
      }

      if (parsed.isDoneCh) {
        await handleDoneChRecovery(pending.msg, context);
      }

      if (pending.attempts >= maxRetries) {
        pendingPromptRetries.delete(msg.id);
        return [msg];
      }

      pending.attempts += 1;
      schedulePromptRetry(msg.id, pending, parsed.isDoneCh ? 0 : delayMs, context);
      return [];
    },

    dispose: (): void => {
      pendingPromptRetries.clear();
    },
  };
}

export const activeTurnCollisionFix = createActiveTurnCollisionFix();
export const createUserSteeringFix = createActiveTurnCollisionFix;
export const userSteeringFix = activeTurnCollisionFix;
export const createPromptRetryFix = createActiveTurnCollisionFix;
export const promptRetryFix = activeTurnCollisionFix;
