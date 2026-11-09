/**
 * Problem:
 * When background subagents or tasks execute concurrently while an assistant message is streaming
 * (or when tool calls, plan updates, or notices arrive during `agent_message_chunk` emissions),
 * upstream `agy_acp_server` pushes these timeline-interrupting events directly into the middle of
 * the streaming text. Editor clients (such as Paseo and Zed) render ACP streams sequentially,
 * splitting the assistant message into broken fragments and severing Markdown links/syntax mid-token.
 *
 * Solution:
 * Buffers incoming concurrent timeline updates (`tool_call`, `tool_call_update`, `plan`,
 * `plan_update`, `plan_removed`, `notice`) while an assistant message is actively streaming,
 * flushing them immediately once the text stream completes (or settles), ensuring text messages
 * remain contiguous and unsevered.
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
import { extractSessionId, getSessionIdForRequest } from "../../core/session-cache.js";

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

export function isTimelineInterruptingUpdate(kind?: string): boolean {
  if (!kind) return false;
  return (
    kind === SESSION_UPDATES.TOOL_CALL ||
    kind === SESSION_UPDATES.TOOL_CALL_UPDATE ||
    kind === SESSION_UPDATES.PLAN ||
    kind === SESSION_UPDATES.PLAN_UPDATE ||
    kind === SESSION_UPDATES.PLAN_REMOVED ||
    kind === SESSION_UPDATES.NOTICE
  );
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
        (m as { _raw?: boolean })._raw = true;
        context.forwardInbound(m);
      }
      return [];
    }
    return flushed;
  }

  bufferTimelineUpdate(sessionId: string, msg: AcpStreamMessage, toolCallId?: string): void {
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

function handleTimelineUpdate(
  msg: AcpStreamMessage,
  update: SessionUpdatePayload,
  sessionId: string,
  buffer: ConcurrentToolCallBuffer,
): AcpStreamMessage[] {
  const kind = update.sessionUpdate;
  if (!isTimelineInterruptingUpdate(kind)) {
    return [msg];
  }

  if (kind === SESSION_UPDATES.TOOL_CALL) {
    if (buffer.isStreaming(sessionId)) {
      buffer.bufferTimelineUpdate(sessionId, msg, update.toolCallId);
      return [];
    }
    return [msg];
  }

  if (kind === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    const toolCallId = update.toolCallId;
    if (toolCallId && buffer.isToolCallBuffered(sessionId, toolCallId)) {
      buffer.bufferTimelineUpdate(sessionId, msg, toolCallId);
      return [];
    }
    return [msg];
  }

  if (buffer.isStreaming(sessionId)) {
    buffer.bufferTimelineUpdate(sessionId, msg);
    return [];
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

  return handleTimelineUpdate(msg, update, sessionId, buffer);
}

function resolveSessionId(msg: AcpStreamMessage, context: InboundContext): string | undefined {
  return (
    extractSessionId(msg) ??
    context.session?.sessionId ??
    (context.sessionCache && "id" in msg && msg.id !== undefined && msg.id !== null
      ? getSessionIdForRequest(context.sessionCache, msg.id)
      : undefined)
  );
}

export function createInterleavedStreamToolCallsFix(
  options?: InterleavedStreamToolCallsOptions,
): AcpFix {
  const buffer = new ConcurrentToolCallBuffer(options);

  return {
    name: "interleaved-stream-tool-calls",
    description:
      "Buffers concurrent subagent tool calls and background plan updates while assistant text is streaming to avoid broken markdown and conversation splitting",

    onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT) || isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          buffer.settleStream(sessionId, context as unknown as InboundContext);
        }
      }
      return msg;
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      if (isJsonRpcResponse(msg)) {
        const sessionId = resolveSessionId(msg, context);
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
