/**
 * Problem:
 * When upstream Antigravity executes tool calls (or receives a prompt) and halts with an empty
 * completion (stopReason=16, no text and no tool call), upstream completes the prompt turn
 * with a successful result without emitting any `agent_message_chunk`. Editor clients (Paseo, Zed)
 * transition the session to idle, leaving the user with zero explanation and an apparent hang.
 *
 * Solution:
 * Tracks prompt turn state and delivered assistant message chunks. When upstream returns a prompt
 * completion without any assistant message chunks, synthesizes a status message explaining the
 * executed actions or prompting continuation before delivering the prompt result.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isJsonRpcRequest,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";

interface TurnState {
  promptId: string | number;
  sessionId: string;
  hasAssistantMessage: boolean;
  toolActionsCount: number;
  lastToolTitle?: string | undefined;
}

interface UpdateParams {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    title?: string;
  };
}

function recordOutboundPrompt(
  msg: AcpStreamMessage,
  activeTurns: Map<string | number, TurnState>,
  sessionTurnMap: Map<string, TurnState>,
): void {
  if (!isJsonRpcRequest(msg) || !("id" in msg) || msg.id === null || msg.id === undefined) {
    return;
  }
  const sessionId = extractSessionId(msg);
  if (!sessionId) {
    return;
  }

  const state: TurnState = {
    promptId: msg.id,
    sessionId,
    hasAssistantMessage: false,
    toolActionsCount: 0,
  };
  activeTurns.set(msg.id, state);
  sessionTurnMap.set(sessionId, state);
}

function processTurnUpdate(state: TurnState, updateType?: string, title?: string): void {
  if (updateType === SESSION_UPDATES.AGENT_MESSAGE_CHUNK) {
    state.hasAssistantMessage = true;
    return;
  }
  if (updateType === SESSION_UPDATES.TOOL_CALL || updateType === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    state.toolActionsCount++;
    if (title) {
      state.lastToolTitle = title;
    }
  }
}

function recordInboundUpdate(msg: AcpStreamMessage, sessionTurnMap: Map<string, TurnState>): void {
  if (!("params" in msg) || !msg.params) {
    return;
  }
  const params = msg.params as UpdateParams;
  const state = params.sessionId ? sessionTurnMap.get(params.sessionId) : undefined;
  if (!state) {
    return;
  }
  processTurnUpdate(state, params.update?.sessionUpdate, params.update?.title);
}

function synthesizeExplanation(state: TurnState): AcpStreamMessage {
  const toolSuffix = state.lastToolTitle ? ` (last action: ${state.lastToolTitle})` : "";
  const text =
    state.toolActionsCount > 0
      ? `Completed actions (${state.toolActionsCount} operations executed)${toolSuffix}. Please let me know how you would like to proceed.`
      : "Received your message. How can I help you proceed?";

  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId: state.sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
        content: { type: "text", text },
      },
    },
  };
}

function resolveInboundResult(
  msg: AcpStreamMessage,
  activeTurns: Map<string | number, TurnState>,
  sessionTurnMap: Map<string, TurnState>,
): AcpStreamMessage[] {
  if (!("result" in msg) || !("id" in msg) || msg.id === null || msg.id === undefined) {
    return [msg];
  }

  const state = activeTurns.get(msg.id);
  if (!state) {
    return [msg];
  }

  activeTurns.delete(msg.id);
  sessionTurnMap.delete(state.sessionId);

  if (state.hasAssistantMessage) {
    return [msg];
  }

  return [synthesizeExplanation(state), msg];
}

export function createPrematureTurnStopFix(): AcpFix {
  const activeTurns = new Map<string | number, TurnState>();
  const sessionTurnMap = new Map<string, TurnState>();

  return {
    name: "premature-turn-stop",
    description: "Detects and recovers from premature empty turn stops without assistant messages",

    getSystemInstructions(): readonly string[] {
      return [
        "Never end a prompt turn without emitting a clear assistant text message summarizing completed actions, current status, or next steps.",
        "When executing commit commands, linter checks, or tests that encounter errors, explicitly explain the failures to the user before attempting further autonomous repairs.",
      ];
    },

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
      if ("method" in msg && msg.method === ACP_METHODS.SESSION_PROMPT) {
        recordOutboundPrompt(msg, activeTurns, sessionTurnMap);
      }
      return msg;
    },

    async onInbound(msg: AcpStreamMessage, _context: InboundContext): Promise<AcpStreamMessage[]> {
      if ("method" in msg && msg.method === ACP_METHODS.SESSION_UPDATE) {
        recordInboundUpdate(msg, sessionTurnMap);
        return [msg];
      }
      if ("result" in msg) {
        return resolveInboundResult(msg, activeTurns, sessionTurnMap);
      }
      return [msg];
    },
  };
}

export const prematureTurnStopFix = createPrematureTurnStopFix();
