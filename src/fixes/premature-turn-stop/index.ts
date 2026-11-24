/**
 * Problem:
 * When upstream Antigravity executes tool calls and halts with an empty completion (stopReason=16,
 * no text and no tool call), upstream completes the prompt turn with a successful result without
 * emitting any `agent_message_chunk`. Editor clients (Paseo, Zed) transition the session to idle,
 * leaving the user with zero explanation and an apparent hang, forcing the user to manually ask
 * "You stopped, status report and next steps?".
 *
 * Solution:
 * In addition to baseline system prompt steering, intercepts empty `endTurn` completions following
 * tool execution at runtime. Automatically dispatches an automated continuation prompt upstream
 * directing the model to summarize its progress and continue executing the task to completion,
 * without synthesizing artificial assistant prose in the proxy.
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

export interface PrematureTurnStopOptions {
  maxContinuations?: number;
}

function extractBlockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    return block.text;
  }
  return "";
}

export function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractBlockText).join("");
  }
  return extractBlockText(content);
}

interface SessionTurnState {
  activePromptId?: string | number | null | undefined;
  toolCallCount: number;
  assistantTextLength: number;
  continuationCount: number;
  continuationPromptId?: string | number | undefined;
}

export class PrematureTurnStopTracker {
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly promptIdToSessionId = new Map<string | number, string>();

  private getOrCreate(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        toolCallCount: 0,
        assistantTextLength: 0,
        continuationCount: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  startTurn(sessionId: string, promptId?: string | number | null): void {
    const state = this.getOrCreate(sessionId);
    state.activePromptId = promptId;
    state.toolCallCount = 0;
    state.assistantTextLength = 0;
    state.continuationCount = 0;
    state.continuationPromptId = undefined;
    if (promptId !== undefined && promptId !== null) {
      this.promptIdToSessionId.set(promptId, sessionId);
    }
  }

  getSessionIdForPrompt(promptId: string | number): string | undefined {
    return this.promptIdToSessionId.get(promptId);
  }

  recordToolCall(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.toolCallCount++;
  }

  recordAssistantText(sessionId: string, length: number): void {
    const state = this.getOrCreate(sessionId);
    state.assistantTextLength += length;
  }

  isPrematureStop(
    sessionId: string,
    promptId: string | number | null | undefined,
    maxContinuations: number,
  ): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    const isMatchingPrompt =
      state.activePromptId === promptId || state.continuationPromptId === promptId;
    return (
      isMatchingPrompt &&
      state.toolCallCount > 0 &&
      state.assistantTextLength === 0 &&
      state.continuationCount < maxContinuations
    );
  }

  getToolCallCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.toolCallCount ?? 0;
  }

  getContinuationCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.continuationCount ?? 0;
  }

  incrementContinuationCount(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.continuationCount++;
  }

  getContinuationPromptId(sessionId: string): string | number | undefined {
    return this.sessions.get(sessionId)?.continuationPromptId;
  }

  setContinuationPromptId(sessionId: string, promptId: string | number): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.continuationPromptId = promptId;
      this.promptIdToSessionId.set(promptId, sessionId);
    }
  }

  clearContinuationPrompt(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.continuationPromptId !== undefined) {
        this.promptIdToSessionId.delete(s.continuationPromptId);
      }
      s.continuationPromptId = undefined;
    }
  }

  getActivePromptId(sessionId: string): string | number | null | undefined {
    return this.sessions.get(sessionId)?.activePromptId;
  }

  clearSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.activePromptId !== undefined && s.activePromptId !== null) {
        this.promptIdToSessionId.delete(s.activePromptId);
      }
      if (s.continuationPromptId !== undefined) {
        this.promptIdToSessionId.delete(s.continuationPromptId);
      }
    }
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.promptIdToSessionId.clear();
  }
}

export function buildContinuationText(toolCallCount: number): string {
  return (
    `[Automated Continuation]: You executed ${toolCallCount} tool calls but stopped without providing a status report or proceeding with the task. ` +
    `Please summarize what you have accomplished, evaluate the current state, and continue executing the next steps to complete the task.`
  );
}

async function dispatchContinuationPrompt(
  sessionId: string,
  tracker: PrematureTurnStopTracker,
  context: InboundContext,
): Promise<boolean> {
  tracker.incrementContinuationCount(sessionId);
  const toolCallCount = tracker.getToolCallCount(sessionId);
  const continuationText = buildContinuationText(toolCallCount);

  const continuationPromptId = `continue_${sessionId}_${Date.now()}`;
  tracker.setContinuationPromptId(sessionId, continuationPromptId);

  try {
    await context.writeToChild({
      jsonrpc: "2.0",
      id: continuationPromptId,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId,
        prompt: [{ type: "text", text: continuationText }],
      },
    } as unknown as AcpStreamMessage);
    return true;
  } catch (err) {
    console.error(`[refined-antigravity-acp] Failed to send automated continuation prompt:`, err);
    return false;
  }
}

function resolveSessionId(
  msg: AcpStreamMessage,
  tracker: PrematureTurnStopTracker,
): string | undefined {
  const fromMsg = extractSessionId(msg);
  if (fromMsg) return fromMsg;
  const id = (msg as { id?: string | number | null }).id;
  return id !== null && id !== undefined ? tracker.getSessionIdForPrompt(id) : undefined;
}

function handleInboundUpdate(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: PrematureTurnStopTracker,
): void {
  const update =
    "params" in msg ? (msg.params as SessionUpdateParams | undefined)?.update : undefined;
  if (!update) return;

  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    tracker.recordToolCall(sessionId);
  } else if (update.sessionUpdate === SESSION_UPDATES.AGENT_MESSAGE_CHUNK) {
    const text = extractContentText(update.content);
    if (text.trim().length > 0) {
      tracker.recordAssistantText(sessionId, text.trim().length);
    }
  }
}

function handleContinuationResponse(
  msg: AcpStreamMessage,
  promptId: string | number | null | undefined,
  sessionId: string,
  tracker: PrematureTurnStopTracker,
): AcpStreamMessage[] | null {
  const continuationPromptId = tracker.getContinuationPromptId(sessionId);
  if (continuationPromptId !== undefined && promptId === continuationPromptId) {
    const originalPromptId = tracker.getActivePromptId(sessionId);
    tracker.clearContinuationPrompt(sessionId);
    return [{ ...msg, id: originalPromptId ?? null }];
  }
  return null;
}

async function handlePromptResult(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: PrematureTurnStopTracker,
  context: InboundContext,
  options: PrematureTurnStopOptions,
): Promise<AcpStreamMessage[] | null> {
  if (!("result" in msg)) return null;

  const promptId = (msg as { id?: string | number | null }).id;
  const res = msg.result as Record<string, unknown> | null;
  const stopReason = res?.stopReason;

  if (stopReason === STOP_REASONS.CANCELLED || stopReason === "cancelled") {
    tracker.clearSession(sessionId);
    return null;
  }

  const maxContinuations = options.maxContinuations ?? 2;
  const isEndTurn = stopReason === STOP_REASONS.END_TURN || stopReason === "endTurn";
  if (isEndTurn && tracker.isPrematureStop(sessionId, promptId, maxContinuations)) {
    const dispatched = await dispatchContinuationPrompt(sessionId, tracker, context);
    if (dispatched) return [];
  }

  return handleContinuationResponse(msg, promptId, sessionId, tracker);
}

export function createPrematureTurnStopFix(options: PrematureTurnStopOptions = {}): AcpFix {
  const tracker = new PrematureTurnStopTracker();

  return {
    name: "premature-turn-stop",
    description:
      "Steers model and intercepts premature empty turn stops without assistant messages to continue e2e execution",

    getSystemInstructions(): readonly string[] {
      return [
        "Never end a prompt turn without emitting a clear assistant text message summarizing completed actions, current status, or next steps.",
      ];
    },

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext) {
      const sessionId = extractSessionId(msg);
      if (!sessionId) return msg;

      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
        const promptId = (msg as { id?: string | number }).id;
        tracker.startTurn(sessionId, promptId);
      } else if (
        isMethod(msg, ACP_METHODS.SESSION_CANCEL) ||
        isMethod(msg, ACP_METHODS.SESSION_CLOSE) ||
        isMethod(msg, ACP_METHODS.SESSION_DELETE)
      ) {
        tracker.clearSession(sessionId);
      }

      return msg;
    },

    async onInbound(msg: AcpStreamMessage, context: InboundContext) {
      const sessionId = resolveSessionId(msg, tracker);
      if (!sessionId) return [msg];

      if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
        handleInboundUpdate(msg, sessionId, tracker);
      }

      const promptHandled = await handlePromptResult(msg, sessionId, tracker, context, options);
      if (promptHandled) return promptHandled;

      return [msg];
    },
  };
}

export const prematureTurnStopFix = createPrematureTurnStopFix();
