/**
 * Problem:
 * When tool execution is backgrounded or turns complete without an explicit terminal tool update,
 * upstream `agy_acp_server` never emits a `tool_call_update` with `status: "completed"`,
 * causing editor client interfaces to display an infinite active running spinner.
 *
 * Solution:
 * Tracks active in-flight tool calls, auto-completing backgrounded commands and flushing any
 * remaining dangling tool calls immediately upon assistant text streaming or turn completion.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";

function isBackgroundedOutput(output: unknown): boolean {
  if (typeof output === "string") {
    return output.includes("is running as a background task");
  }
  if (output && typeof output === "object") {
    try {
      return JSON.stringify(output).includes("is running as a background task");
    } catch {
      return false;
    }
  }
  return false;
}

function createToolCompletionMessage(sessionId: string, toolCallId: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
        toolCallId,
        status: "completed",
      },
    },
  };
}

export class ToolCallTracker {
  private readonly activeToolCalls = new Map<string, Set<string>>();

  recordToolCall(sessionId: string, toolCallId: string): void {
    let set = this.activeToolCalls.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.activeToolCalls.set(sessionId, set);
    }
    set.add(toolCallId);
  }

  resolveToolCall(sessionId: string, toolCallId: string): void {
    const set = this.activeToolCalls.get(sessionId);
    if (set) {
      set.delete(toolCallId);
      if (set.size === 0) {
        this.activeToolCalls.delete(sessionId);
      }
    }
  }

  hasActiveToolCalls(sessionId: string): boolean {
    const set = this.activeToolCalls.get(sessionId);
    return (set?.size ?? 0) > 0;
  }

  getActiveToolCalls(sessionId: string): string[] {
    const set = this.activeToolCalls.get(sessionId);
    return set ? Array.from(set) : [];
  }

  clearSession(sessionId: string): void {
    this.activeToolCalls.delete(sessionId);
  }

  flushDangling(sessionId: string, exceptToolCallId?: string): AcpStreamMessage[] {
    const set = this.activeToolCalls.get(sessionId);
    if (!set || set.size === 0) return [];

    const messages: AcpStreamMessage[] = [];
    for (const toolCallId of set) {
      if (exceptToolCallId && toolCallId === exceptToolCallId) continue;
      messages.push(createToolCompletionMessage(sessionId, toolCallId));
    }

    if (exceptToolCallId && set.has(exceptToolCallId)) {
      set.clear();
      set.add(exceptToolCallId);
    } else {
      this.activeToolCalls.delete(sessionId);
    }

    return messages;
  }

  dispose(): void {
    this.activeToolCalls.clear();
  }
}

function handleToolCall(
  update: SessionUpdatePayload,
  sessionId: string,
  tracker: ToolCallTracker,
): AcpStreamMessage[] {
  const toolCallId = update.toolCallId;
  const flushMessages = tracker.flushDangling(sessionId, toolCallId);

  if (toolCallId) {
    if (update.status === "completed" || update.status === "failed") {
      tracker.resolveToolCall(sessionId, toolCallId);
    } else if (isBackgroundedOutput(update.rawOutput) || isBackgroundedOutput(update.content)) {
      update.status = "completed";
      tracker.resolveToolCall(sessionId, toolCallId);
    } else {
      tracker.recordToolCall(sessionId, toolCallId);
    }
  }
  return flushMessages;
}

function handleToolCallUpdate(
  update: SessionUpdatePayload,
  sessionId: string,
  tracker: ToolCallTracker,
): void {
  const toolCallId = update.toolCallId;
  if (!toolCallId) return;

  if (update.status === "completed" || update.status === "failed") {
    tracker.resolveToolCall(sessionId, toolCallId);
  } else if (isBackgroundedOutput(update.rawOutput) || isBackgroundedOutput(update.content)) {
    update.status = "completed";
    tracker.resolveToolCall(sessionId, toolCallId);
  }
}

function handleMessageChunk(
  sessionId: string,
  tracker: ToolCallTracker,
  msg: AcpStreamMessage,
): AcpStreamMessage[] {
  if (tracker.hasActiveToolCalls(sessionId)) {
    const completions = tracker.flushDangling(sessionId);
    return [...completions, msg];
  }
  return [msg];
}

function processInbound(msg: AcpStreamMessage, tracker: ToolCallTracker): AcpStreamMessage[] {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return [msg];

  const sessionId = extractSessionId(msg);
  if (!sessionId) return [msg];

  const update = (msg.params as SessionUpdateParams | undefined)?.update;
  if (!update) return [msg];

  const kind = update.sessionUpdate;
  if (kind === SESSION_UPDATES.TOOL_CALL) {
    const flushMessages = handleToolCall(update, sessionId, tracker);
    return [...flushMessages, msg];
  }
  if (kind === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    handleToolCallUpdate(update, sessionId, tracker);
    return [msg];
  }
  if (
    kind === SESSION_UPDATES.AGENT_MESSAGE_CHUNK ||
    kind === SESSION_UPDATES.AGENT_THOUGHT_CHUNK
  ) {
    return handleMessageChunk(sessionId, tracker, msg);
  }
  return [msg];
}

function processOutbound(msg: AcpStreamMessage, tracker: ToolCallTracker): AcpStreamMessage {
  if (isMethod(msg, ACP_METHODS.SESSION_PROMPT) || isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
    const sessionId = extractSessionId(msg);
    if (sessionId) tracker.clearSession(sessionId);
  }
  return msg;
}

export function createDanglingToolCallsFix(): AcpFix & { tracker: ToolCallTracker } {
  const tracker = new ToolCallTracker();

  return {
    name: "dangling-tool-calls",
    description:
      "Auto-completes dangling and backgrounded tool calls on turn boundaries to stop infinite spinners",
    tracker,

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
      return processOutbound(msg, tracker);
    },

    onInbound(msg: AcpStreamMessage, _context: InboundContext): AcpStreamMessage[] {
      return processInbound(msg, tracker);
    },

    onTurnEnd(sessionId: string, _context: InboundContext): AcpStreamMessage[] {
      return tracker.flushDangling(sessionId);
    },

    onRecycle(): void {
      tracker.dispose();
    },

    dispose(): void {
      tracker.dispose();
    },
  };
}

export const danglingToolCallsFix = createDanglingToolCallsFix();
export const createToolCallCleanupFix = createDanglingToolCallsFix;
export const toolCallCleanupFix = danglingToolCallsFix;
