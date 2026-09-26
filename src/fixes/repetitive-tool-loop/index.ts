/**
 * Problem:
 * Upstream `agy_acp_server` does not detect repetitive tool calling loops or autoregressive attractor cycles.
 * When a model degenerates into repeating the same tool call or cycling through the same set of file slices,
 * raw agy blindly executes tool calls indefinitely, burning thousands of tokens and freezing editor sessions.
 *
 * Solution:
 * Tracks canonicalized tool call signatures per prompt turn using suffix cycle matching.
 * When identical tool calls or periodic cycles repeat beyond safety thresholds, the wrapper sends
 * `session/cancel` upstream to halt runaway execution, auto-completes pending tool updates, emits an
 * explanatory message chunk to the editor chat, and cleanly settles the turn.
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

export const IGNORED_METADATA_KEYS = new Set(["toolaction", "toolsummary", "description"]);

export const READ_ONLY_TOOLS = new Set([
  "view_file",
  "list_directory",
  "find_file",
  "read_url_content",
  "search_web",
  "read_file",
]);

export interface RepetitiveToolLoopOptions {
  maxPeriod?: number;
  readOnlySingleThreshold?: number;
  mutatingSingleThreshold?: number;
  cycleThreshold?: number;
}

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

export function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val !== "object") return val;
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const sortedObj: Record<string, unknown> = {};
  const entries = Object.entries(val as Record<string, unknown>);
  const filteredEntries = entries.filter(([k]) => !IGNORED_METADATA_KEYS.has(normalizeKey(k)));
  filteredEntries.sort(([a], [b]) => normalizeKey(a).localeCompare(normalizeKey(b)));
  for (const [k, v] of filteredEntries) {
    sortedObj[normalizeKey(k)] = canonicalizeValue(v);
  }
  return sortedObj;
}

export function inferToolNameFromUpdate(
  title?: string | null,
  kind?: string | null,
  rawInput?: unknown,
): string {
  if (title) {
    const cleaned = title.replace(/^Running:?\s+/i, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  if (kind && kind !== "other") {
    return kind;
  }
  if (rawInput && typeof rawInput === "object") {
    if ("CommandLine" in (rawInput as Record<string, unknown>)) return "run_command";
    if ("AbsolutePath" in (rawInput as Record<string, unknown>)) return "view_file";
    if ("Subagents" in (rawInput as Record<string, unknown>)) return "invoke_subagent";
  }
  return "tool";
}

export function computeToolCallSignature(toolName: string, rawInput: unknown): string {
  let parsedInput = rawInput;
  if (typeof rawInput === "string") {
    try {
      parsedInput = JSON.parse(rawInput);
    } catch {
      parsedInput = rawInput;
    }
  }
  const canonical = canonicalizeValue(parsedInput);
  return `${toolName}:${JSON.stringify(canonical)}`;
}

export interface CycleDetectionResult {
  isLoop: boolean;
  cycleLength: number;
  repetitions: number;
  pattern: string[];
}

function isSuffixCycleMatch(
  signatures: readonly string[],
  n: number,
  k: number,
  repetitions: number,
): boolean {
  for (let r = 1; r < repetitions; r++) {
    for (let i = 0; i < k; i++) {
      if (signatures[n - k + i] !== signatures[n - (r + 1) * k + i]) {
        return false;
      }
    }
  }
  return true;
}

export function detectCycle(
  signatures: readonly string[],
  options: {
    maxPeriod?: number;
    singleToolThreshold?: number;
    cycleThreshold?: number;
  } = {},
): CycleDetectionResult {
  const maxPeriod = options.maxPeriod ?? 4;
  const singleToolThreshold = options.singleToolThreshold ?? 3;
  const cycleThreshold = options.cycleThreshold ?? 3;
  const n = signatures.length;

  for (let k = 1; k <= maxPeriod; k++) {
    const requiredRepetitions = k === 1 ? singleToolThreshold : cycleThreshold;
    const requiredLength = k * requiredRepetitions;
    if (n < requiredLength) continue;

    if (isSuffixCycleMatch(signatures, n, k, requiredRepetitions)) {
      return {
        isLoop: true,
        cycleLength: k,
        repetitions: requiredRepetitions,
        pattern: signatures.slice(n - k),
      };
    }
  }

  return {
    isLoop: false,
    cycleLength: 0,
    repetitions: 0,
    pattern: [],
  };
}

interface SessionTurnState {
  activePromptId?: string | number | undefined;
  signatures: string[];
  loopInterrupted: boolean;
}

export class RepetitiveToolLoopTracker {
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly promptIdToSessionId = new Map<string | number, string>();

  private getOrCreate(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { signatures: [], loopInterrupted: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  startTurn(sessionId: string, promptId?: string | number): void {
    const state = this.getOrCreate(sessionId);
    state.activePromptId = promptId;
    state.signatures = [];
    state.loopInterrupted = false;
    if (promptId !== undefined && promptId !== null) {
      this.promptIdToSessionId.set(promptId, sessionId);
    }
  }

  getSessionIdForPrompt(promptId: string | number): string | undefined {
    return this.promptIdToSessionId.get(promptId);
  }

  recordToolCall(
    sessionId: string,
    toolName: string,
    rawInput: unknown,
    options: RepetitiveToolLoopOptions = {},
  ): CycleDetectionResult {
    const state = this.getOrCreate(sessionId);
    if (state.loopInterrupted) {
      return { isLoop: true, cycleLength: 0, repetitions: 0, pattern: [] };
    }

    const signature = computeToolCallSignature(toolName, rawInput);
    state.signatures.push(signature);

    const isReadOnly = READ_ONLY_TOOLS.has(toolName);
    const singleThreshold = isReadOnly
      ? (options.readOnlySingleThreshold ?? 3)
      : (options.mutatingSingleThreshold ?? 5);

    const result = detectCycle(state.signatures, {
      maxPeriod: options.maxPeriod ?? 4,
      singleToolThreshold: singleThreshold,
      cycleThreshold: options.cycleThreshold ?? 3,
    });

    if (result.isLoop) {
      state.loopInterrupted = true;
    }

    return result;
  }

  isLoopInterrupted(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loopInterrupted ?? false;
  }

  getActivePromptId(sessionId: string): string | number | undefined {
    return this.sessions.get(sessionId)?.activePromptId;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
    this.promptIdToSessionId.clear();
  }
}

async function interruptLoopExecution(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  loopResult: CycleDetectionResult,
  context: InboundContext,
): Promise<void> {
  await context
    .writeToChild({
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_CANCEL,
      params: { sessionId },
    } as unknown as AcpStreamMessage)
    .catch(() => {});

  context.forwardInbound?.({
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
  } as unknown as AcpStreamMessage);

  const cycleDesc =
    loopResult.cycleLength > 1
      ? `a cycle of ${loopResult.cycleLength} alternating tool calls`
      : `identical tool call (${toolName})`;

  context.forwardInbound?.({
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
        content: {
          type: "text",
          text: `\n\n⚠️ Interrupted repetitive tool calling loop: detected ${cycleDesc} repeating without progress. Stopping turn to prevent runaway token usage.`,
        },
      },
    },
  } as unknown as AcpStreamMessage);
}

function settleInterruptedPromptResponse(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
): AcpStreamMessage[] | null {
  if (!("result" in msg) || !tracker.isLoopInterrupted(sessionId)) {
    return null;
  }
  const res = msg.result as Record<string, unknown> | null;
  if (res && (res.stopReason === STOP_REASONS.CANCELLED || !res.stopReason)) {
    tracker.startTurn(sessionId);
    return [
      {
        ...msg,
        result: {
          ...res,
          stopReason: STOP_REASONS.END_TURN,
        },
      },
    ];
  }
  return null;
}

function resolveSessionId(
  msg: AcpStreamMessage,
  tracker: RepetitiveToolLoopTracker,
): string | undefined {
  const fromMsg = extractSessionId(msg);
  if (fromMsg) return fromMsg;
  const id = (msg as { id?: string | number | null }).id;
  return id !== null && id !== undefined ? tracker.getSessionIdForPrompt(id) : undefined;
}

async function handleInboundSessionUpdate(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
  options: RepetitiveToolLoopOptions,
  context: InboundContext,
): Promise<AcpStreamMessage[] | null> {
  const update =
    "params" in msg ? (msg.params as SessionUpdateParams | undefined)?.update : undefined;
  if (update?.sessionUpdate !== SESSION_UPDATES.TOOL_CALL) {
    return null;
  }
  const toolCallId = update.toolCallId ?? "unknown";
  const toolName = inferToolNameFromUpdate(update.title, update.kind, update.rawInput);
  const loopResult = tracker.recordToolCall(sessionId, toolName, update.rawInput, options);
  if (loopResult.isLoop) {
    await interruptLoopExecution(sessionId, toolCallId, toolName, loopResult, context);
    return [];
  }
  return null;
}

export function createRepetitiveToolLoopFix(options: RepetitiveToolLoopOptions = {}): AcpFix {
  const tracker = new RepetitiveToolLoopTracker();

  return {
    name: "repetitive-tool-loop",
    description:
      "Detects and interrupts repetitive tool calling cycles and autoregressive attractor loops",

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext) {
      const sessionId = extractSessionId(msg);
      if (!sessionId) return msg;

      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
        const promptId = (msg as { id?: string | number }).id;
        tracker.startTurn(sessionId, promptId);
      }

      return msg;
    },

    async onInbound(msg: AcpStreamMessage, context: InboundContext) {
      const sessionId = resolveSessionId(msg, tracker);
      if (!sessionId) return [msg];

      const settled = settleInterruptedPromptResponse(msg, sessionId, tracker);
      if (settled) return settled;

      if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
        const handled = await handleInboundSessionUpdate(msg, sessionId, tracker, options, context);
        if (handled) return handled;
      }

      return [msg];
    },
  };
}

export const repetitiveToolLoopFix = createRepetitiveToolLoopFix();
