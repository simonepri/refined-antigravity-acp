/**
 * Problem:
 * When reconnecting or reloading a session via `session/load`, upstream `agy_acp_server`
 * drops thought chains, intermediate reasoning steps, and agent message chunks, loading an incomplete history.
 *
 * Solution:
 * Reads raw protobuf-encoded conversation steps directly from the session's SQLite database,
 * reconstructing thought and message update events for session replay.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  isJsonRpcRequest,
  isMethod,
  type AcpStreamMessage,
  type AcpFix,
  type InboundContext,
  type OutboundContext,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";
import {
  getConversationDbPath,
  STEP_TYPE_USER,
  STEP_TYPE_AGENT,
} from "../orphaned-checkpoints/index.js";

import { stripSteeringPrefix } from "../active-turn-collision/index.js";
import { stripSystemContext } from "../missing-system-prompt/index.js";
import { sanitizeText } from "../malformed-stream-syntax/index.js";
import { decodeVarint, getField } from "../../lib/protobuf.js";

export { decodeVarint, getField };

interface StepRow {
  readonly idx: number;
  readonly step_type: number;
  readonly step_payload: Uint8Array | null;
}

export function extractTimestamp(payload: Uint8Array): string | undefined {
  const f1 = getField(getField(payload, 5) ?? new Uint8Array(), 1);
  if (!f1) return undefined;
  let offset = 0;
  let seconds = 0;
  let nanos = 0;
  while (offset < f1.length) {
    const [tag, nextOffset] = decodeVarint(f1, offset);
    const [val, afterVal] = decodeVarint(f1, nextOffset);
    offset = afterVal;
    if (tag >> 3 === 1) seconds = val;
    else if (tag >> 3 === 2) nanos = val;
  }
  return seconds
    ? new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString()
    : undefined;
}

export type ConversationStep =
  | {
      readonly kind: "user" | "assistant" | "thought";
      readonly idx: number;
      readonly text: string;
      readonly timestamp?: string | undefined;
    }
  | {
      readonly kind: "tool_call";
      readonly idx: number;
      readonly callId: string;
      readonly name: string;
      readonly rawInputJson: string;
      readonly timestamp?: string | undefined;
    };

export { STEP_TYPE_USER, STEP_TYPE_AGENT };

export function utf8(bytes: Uint8Array | null): string {
  return bytes && bytes.length > 0 ? Buffer.from(bytes).toString("utf-8") : "";
}

export function decodeStep(
  stepType: number,
  payload: Uint8Array,
  idx: number,
  timestamp?: string,
): ConversationStep[] {
  if (stepType === STEP_TYPE_USER) {
    const f19 = getField(payload, 19);
    if (!f19) return [];
    const text = stripSystemContext(stripSteeringPrefix(utf8(getField(f19, 2)))).trim();
    return text ? [{ kind: "user", idx, text, timestamp }] : [];
  }
  if (stepType === STEP_TYPE_AGENT) {
    const f20 = getField(payload, 20);
    if (!f20) return [];
    const steps: ConversationStep[] = [];
    const thought = utf8(getField(f20, 3)).trim();
    if (thought) steps.push({ kind: "thought", idx, text: thought, timestamp });
    const text = sanitizeText(utf8(getField(f20, 1)));
    if (text) steps.push({ kind: "assistant", idx, text, timestamp });
    const call = getField(f20, 7);
    const callId = call ? utf8(getField(call, 1)) : "";
    if (callId) {
      steps.push({
        kind: "tool_call",
        idx,
        callId,
        name: utf8(getField(call!, 2)),
        rawInputJson: utf8(getField(call!, 3)),
        timestamp,
      });
    }
    return steps;
  }
  return [];
}

export function conversationDbPath(sessionId: string, customDbPath?: string): string {
  return customDbPath ?? getConversationDbPath(sessionId);
}

export function readConversationSteps(
  sessionId: string,
  customDbPath?: string,
): ConversationStep[] {
  const dbPath = conversationDbPath(sessionId, customDbPath);
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const rows = db
      .prepare(
        "SELECT idx, step_type, step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx ASC;",
      )
      .all() as unknown as StepRow[];
    return rows.flatMap((row) =>
      row.step_payload
        ? decodeStep(
            row.step_type,
            new Uint8Array(row.step_payload),
            row.idx,
            extractTimestamp(new Uint8Array(row.step_payload)),
          )
        : [],
    );
  } catch (err) {
    console.error(
      `[refined-antigravity-acp] Failed to read conversation steps for ${sessionId}:`,
      err,
    );
    return [];
  } finally {
    db?.close();
  }
}

export function deriveToolTitle(name: string, rawInputJson: string): string {
  try {
    const parsed: unknown = JSON.parse(rawInputJson);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { CommandLine?: unknown }).CommandLine === "string"
    ) {
      return (parsed as { CommandLine: string }).CommandLine;
    }
  } catch {
    // ignore
  }
  return name || "tool call";
}

export function sessionUpdateMessage(
  sessionId: string,
  update: Record<string, unknown>,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: { sessionId, update },
  } as unknown as AcpStreamMessage;
}

export function textChunkUpdate(
  sessionId: string,
  sessionUpdate:
    | typeof SESSION_UPDATES.USER_MESSAGE_CHUNK
    | typeof SESSION_UPDATES.AGENT_MESSAGE_CHUNK
    | typeof SESSION_UPDATES.AGENT_THOUGHT_CHUNK,
  text: string,
): AcpStreamMessage {
  return sessionUpdateMessage(sessionId, { sessionUpdate, content: { type: "text", text } });
}

export function toolCallUpdates(
  sessionId: string,
  step: Extract<ConversationStep, { kind: "tool_call" }>,
): AcpStreamMessage[] {
  return [
    sessionUpdateMessage(sessionId, {
      sessionUpdate: SESSION_UPDATES.TOOL_CALL,
      toolCallId: step.callId,
      title: deriveToolTitle(step.name, step.rawInputJson),
      kind: "execute",
      status: "completed",
      rawInput: step.rawInputJson,
    }),
    sessionUpdateMessage(sessionId, {
      sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
      toolCallId: step.callId,
      status: "completed",
    }),
  ];
}

export function synthesizeStepUpdates(
  sessionId: string,
  step: ConversationStep,
): AcpStreamMessage[] {
  if (step.kind === "user")
    return [textChunkUpdate(sessionId, SESSION_UPDATES.USER_MESSAGE_CHUNK, step.text)];
  if (step.kind === "assistant")
    return [textChunkUpdate(sessionId, SESSION_UPDATES.AGENT_MESSAGE_CHUNK, step.text)];
  if (step.kind === "thought")
    return [textChunkUpdate(sessionId, SESSION_UPDATES.AGENT_THOUGHT_CHUNK, step.text)];
  if (step.kind === "tool_call") return toolCallUpdates(sessionId, step);
  return [];
}

export function synthesizeReplayUpdates(
  sessionId: string,
  steps: readonly ConversationStep[],
): AcpStreamMessage[] {
  return steps.flatMap((s) => synthesizeStepUpdates(sessionId, s));
}

const pendingReplayLoads = new Map<string | number, string>();

function consumePendingLoadSession(msg: AcpStreamMessage): string | undefined {
  if (!("id" in msg) || msg.id === null || msg.id === undefined) return undefined;
  const sessionId = pendingReplayLoads.get(msg.id);
  if (sessionId !== undefined) {
    pendingReplayLoads.delete(msg.id);
  }
  return sessionId;
}

export interface DroppedHistoryChunksFix extends AcpFix {
  readConversationSteps?: (sessionId: string, customDbPath?: string) => ConversationStep[];
}

export const droppedHistoryChunksFix: DroppedHistoryChunksFix = {
  name: "dropped-history-chunks",
  description:
    "Reconstructs complete conversation history including thought chains from SQLite steps on session/load",
  readConversationSteps,

  onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
    if (isJsonRpcRequest(msg) && msg.method === ACP_METHODS.SESSION_LOAD) {
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        pendingReplayLoads.set(msg.id, sessionId);
      }
    }
    return msg;
  },

  onInbound(
    this: DroppedHistoryChunksFix,
    msg: AcpStreamMessage,
    _context: InboundContext,
  ): AcpStreamMessage[] {
    if (pendingReplayLoads.size === 0) return [msg];
    if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return [];

    const sessionId = consumePendingLoadSession(msg);
    if (sessionId && "result" in msg) {
      const fn =
        this?.readConversationSteps ??
        droppedHistoryChunksFix.readConversationSteps ??
        readConversationSteps;
      const steps = fn(sessionId);
      return [...synthesizeReplayUpdates(sessionId, steps), msg];
    }
    return [msg];
  },

  dispose(): void {
    pendingReplayLoads.clear();
  },
};

export type HistoryReconstructionFix = DroppedHistoryChunksFix;
export const historyReconstructionFix = droppedHistoryChunksFix;
