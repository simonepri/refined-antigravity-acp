/**
 * Problem:
 * When background subagents execute tool calls concurrently while an assistant message is streaming
 * (or when concurrent tool calls arrive during `agent_message_chunk` emissions), upstream `agy_acp_server`
 * pushes `tool_call` and `tool_call_update` events directly into the middle of the streaming text.
 * Editor clients (such as Paseo and Zed) render ACP streams sequentially, splitting the assistant
 * message into broken fragments and severing Markdown links/syntax mid-token.
 *
 * Solution:
 * Buffers incoming concurrent `tool_call` and `tool_call_update` events while an assistant message
 * is actively streaming, flushing them immediately once the text stream completes (or settles),
 * ensuring text messages remain contiguous and unsevered.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isJsonRpcResponse,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 150;

export interface InterleavedStreamToolCallsOptions {
  idleTimeoutMs?: number;
}

interface SessionStreamState {
  isStreaming: boolean;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  bufferedMessages: AcpStreamMessage[];
  bufferedToolCallIds: Set<string>;
}

export class ConcurrentToolCallBuffer {
  private readonly states = new Map<string, SessionStreamState>();
  private readonly idleTimeoutMs: number;

  constructor(options?: InterleavedStreamToolCallsOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  private getOrCreateState(sessionId: string): SessionStreamState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        isStreaming: false,
        bufferedMessages: [],
        bufferedToolCallIds: new Set<string>(),
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  isStreaming(sessionId: string): boolean {
    return this.states.get(sessionId)?.isStreaming ?? false;
  }

  hasBuffered(sessionId: string): boolean {
    const state = this.states.get(sessionId);
    return Boolean(state && state.bufferedMessages.length > 0);
  }

  getBufferedCount(sessionId: string): number {
    return this.states.get(sessionId)?.bufferedMessages.length ?? 0;
  }

  onMessageChunk(sessionId: string, context?: InboundContext): void {
    const state = this.getOrCreateState(sessionId);
    state.isStreaming = true;

    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      this.settleStream(sessionId, context);
    }, this.idleTimeoutMs);
  }

  settleStream(sessionId: string, context?: InboundContext): AcpStreamMessage[] {
    const state = this.states.get(sessionId);
    if (!state) return [];

    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    state.isStreaming = false;

    const flushed = this.flush(sessionId);
    if (context && flushed.length > 0) {
      for (const m of flushed) {
        context.forwardInbound(m);
      }
      return [];
    }
    return flushed;
  }

  bufferToolCall(sessionId: string, msg: AcpStreamMessage, toolCallId?: string): void {
    const state = this.getOrCreateState(sessionId);
    state.bufferedMessages.push(msg);
    if (toolCallId) {
      state.bufferedToolCallIds.add(toolCallId);
    }
  }

  isToolCallBuffered(sessionId: string, toolCallId: string): boolean {
    const state = this.states.get(sessionId);
    return Boolean(state && state.bufferedToolCallIds.has(toolCallId));
  }

  flush(sessionId: string): AcpStreamMessage[] {
    const state = this.states.get(sessionId);
    if (!state || state.bufferedMessages.length === 0) return [];

    const messages = state.bufferedMessages;
    state.bufferedMessages = [];
    state.bufferedToolCallIds.clear();
    return messages;
  }

  clear(sessionId: string): AcpStreamMessage[] {
    const state = this.states.get(sessionId);
    if (!state) return [];
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    state.isStreaming = false;
    return this.flush(sessionId);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.idleTimer !== undefined) {
        clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
    }
    this.states.clear();
  }
}

function handleToolUpdate(
  msg: AcpStreamMessage,
  update: SessionUpdatePayload,
  sessionId: string,
  buffer: ConcurrentToolCallBuffer,
): AcpStreamMessage[] {
  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    if (buffer.isStreaming(sessionId)) {
      buffer.bufferToolCall(sessionId, msg, update.toolCallId);
      return [];
    }
    return [msg];
  }

  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    const toolCallId = update.toolCallId;
    if (toolCallId && buffer.isToolCallBuffered(sessionId, toolCallId)) {
      buffer.bufferToolCall(sessionId, msg, toolCallId);
      return [];
    }
    return [msg];
  }

  return [msg];
}

function handleSessionUpdate(
  msg: AcpStreamMessage,
  buffer: ConcurrentToolCallBuffer,
  context: InboundContext,
): AcpStreamMessage[] {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return [msg];

  const params = "params" in msg ? (msg.params as SessionUpdateParams | undefined) : undefined;
  const update = params?.update;
  if (!update) return [msg];

  const kind = update.sessionUpdate;
  if (
    kind === SESSION_UPDATES.AGENT_MESSAGE_CHUNK ||
    kind === SESSION_UPDATES.AGENT_THOUGHT_CHUNK
  ) {
    buffer.onMessageChunk(sessionId, context);
    return [msg];
  }

  return handleToolUpdate(msg, update, sessionId, buffer);
}

export function createInterleavedStreamToolCallsFix(
  options?: InterleavedStreamToolCallsOptions,
): AcpFix {
  const buffer = new ConcurrentToolCallBuffer(options);

  return {
    name: "interleaved-stream-tool-calls",
    description:
      "Buffers concurrent subagent and background tool calls while assistant text is streaming to avoid broken markdown and conversation splitting",

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT) || isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          buffer.settleStream(sessionId);
        }
      }
      return msg;
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      if (isJsonRpcResponse(msg)) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          const flushed = buffer.clear(sessionId);
          return [...flushed, msg];
        }
        return [msg];
      }

      if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return [msg];
      return handleSessionUpdate(msg, buffer, context);
    },

    onTurnEnd(sessionId: string, _context: InboundContext): AcpStreamMessage[] {
      return buffer.clear(sessionId);
    },

    dispose(): void {
      buffer.dispose();
    },
  };
}

export const interleavedStreamToolCallsFix: AcpFix = createInterleavedStreamToolCallsFix();
