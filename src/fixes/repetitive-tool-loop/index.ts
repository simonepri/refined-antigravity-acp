/**
 * Problem:
 * Upstream `agy_acp_server` does not detect repetitive tool calling loops or autoregressive attractor cycles.
 * When a model degenerates into repeating the same tool call or cycling through the same set of file slices,
 * raw agy blindly executes tool calls indefinitely, burning thousands of tokens and freezing editor sessions.
 * Furthermore, blindly halting every repeated tool breaks legitimate user polling (e.g. polling a port or waiting for builds).
 *
 * Solution:
 * Tracks canonicalized tool call signatures per prompt turn using suffix cycle matching.
 * Recognizes user polling intent (e.g. "until", "poll", "retry", "wait for", "N times") to allow legitimate polling.
 * When an unintentional runaway loop is detected, interrupts the repetitive execution and sends automated steering
 * ("You have repeatedly executed X, is that expected?") directly to the upstream model so it self-corrects without
 * ending the turn or polluting the user's chat.
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

export const POLLING_INTENT_PATTERN =
  /\b(?:until|poll|polling|wait\s+for|retry|retrying|keep\s+checking|repeat|repeatedly|loop|while|monitor|status\s+code\s+200|\d+\s*times)\b/i;

export function extractPromptText(msg: AcpStreamMessage): string {
  const prompt = (msg as { params?: { prompt?: unknown } })?.params?.prompt;
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((b) => b && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ");
}

export function hasPollingIntent(promptText: string): boolean {
  return POLLING_INTENT_PATTERN.test(promptText);
}

export function extractRequestedIterations(promptText: string): number | undefined {
  const match = promptText.match(/(\d+)\s*times\b/i);
  if (match && match[1]) {
    const num = Math.trunc(Number(match[1]));
    if (!Number.isNaN(num) && num > 0) return num;
  }
  return undefined;
}

export interface RepetitiveToolLoopOptions {
  maxPeriod?: number;
  readOnlySingleThreshold?: number;
  mutatingSingleThreshold?: number;
  pollingSingleThreshold?: number;
  cycleThreshold?: number;
  maxSteersPerTurn?: number;
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

function isDegenerateSingleItem(signatures: readonly string[], n: number, k: number): boolean {
  if (k <= 1) return false;
  for (let i = 1; i < k; i++) {
    if (signatures[n - k + i] !== signatures[n - k]) {
      return false;
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
    if (n < requiredLength || isDegenerateSingleItem(signatures, n, k)) {
      continue;
    }

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
  activePromptId?: string | number | null | undefined;
  userPromptText: string;
  hasPollingIntent: boolean;
  requestedIterations?: number | undefined;
  signatures: string[];
  loopInterrupted: boolean;
  steerPending: boolean;
  steerPromptId?: string | number | undefined;
  steerCount: number;
  lastLoopResult?: CycleDetectionResult | undefined;
  lastToolName?: string | undefined;
}

function resolveSingleThreshold(
  isReadOnly: boolean,
  hasPolling: boolean,
  requestedIterations: number | undefined,
  options: RepetitiveToolLoopOptions,
): number {
  if (isReadOnly) return options.readOnlySingleThreshold ?? 3;
  if (!hasPolling) return options.mutatingSingleThreshold ?? 5;
  const basePolling = options.pollingSingleThreshold ?? 30;
  return requestedIterations ? Math.max(requestedIterations + 2, basePolling) : basePolling;
}

export class RepetitiveToolLoopTracker {
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly promptIdToSessionId = new Map<string | number, string>();

  private getOrCreate(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        signatures: [],
        loopInterrupted: false,
        userPromptText: "",
        hasPollingIntent: false,
        steerPending: false,
        steerCount: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  startTurn(sessionId: string, promptId?: string | number, promptText = ""): void {
    const state = this.getOrCreate(sessionId);
    state.activePromptId = promptId;
    state.userPromptText = promptText;
    state.hasPollingIntent = hasPollingIntent(promptText);
    state.requestedIterations = extractRequestedIterations(promptText);
    state.signatures = [];
    state.loopInterrupted = false;
    state.steerPending = false;
    state.steerPromptId = undefined;
    state.steerCount = 0;
    state.lastLoopResult = undefined;
    state.lastToolName = undefined;
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
    const singleThreshold = resolveSingleThreshold(
      isReadOnly,
      state.hasPollingIntent,
      state.requestedIterations,
      options,
    );

    const result = detectCycle(state.signatures, {
      maxPeriod: options.maxPeriod ?? 4,
      singleToolThreshold: singleThreshold,
      cycleThreshold: options.cycleThreshold ?? 3,
    });

    if (result.isLoop) {
      state.loopInterrupted = true;
      state.lastLoopResult = result;
      state.lastToolName = toolName;
    }

    return result;
  }

  isLoopInterrupted(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loopInterrupted ?? false;
  }

  isSteerPending(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.steerPending ?? false;
  }

  setSteerPending(sessionId: string, pending: boolean): void {
    const s = this.sessions.get(sessionId);
    if (s) s.steerPending = pending;
  }

  getSteerPromptId(sessionId: string): string | number | undefined {
    return this.sessions.get(sessionId)?.steerPromptId;
  }

  setSteerPromptId(sessionId: string, promptId: string | number): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.steerPromptId = promptId;
      this.promptIdToSessionId.set(promptId, sessionId);
    }
  }

  clearSteerPrompt(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.steerPromptId !== undefined) {
        this.promptIdToSessionId.delete(s.steerPromptId);
      }
      s.steerPromptId = undefined;
    }
  }

  getSteerCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.steerCount ?? 0;
  }

  incrementSteerCount(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.steerCount++;
  }

  getLastToolName(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.lastToolName;
  }

  getLastLoopResult(sessionId: string): CycleDetectionResult | undefined {
    return this.sessions.get(sessionId)?.lastLoopResult;
  }

  resetSignaturesForSteering(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.signatures = [];
      s.loopInterrupted = false;
    }
  }

  getActivePromptId(sessionId: string): string | number | null | undefined {
    return this.sessions.get(sessionId)?.activePromptId;
  }

  hasPollingIntent(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.hasPollingIntent ?? false;
  }

  clearSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (s.activePromptId !== undefined && s.activePromptId !== null) {
        this.promptIdToSessionId.delete(s.activePromptId);
      }
      if (s.steerPromptId !== undefined) {
        this.promptIdToSessionId.delete(s.steerPromptId);
      }
    }
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
  _toolName: string,
  _loopResult: CycleDetectionResult,
  tracker: RepetitiveToolLoopTracker,
  context: InboundContext,
): Promise<void> {
  // Cancel upstream execution so the model stops repeating the tool
  await context
    .writeToChild({
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_CANCEL,
      params: { sessionId },
    } as unknown as AcpStreamMessage)
    .catch(() => {});

  // Mark the pending tool call as completed in the client UI so it doesn't spin
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

  // Mark that this session should receive automated steering when upstream finishes cancellation
  tracker.setSteerPending(sessionId, true);
}

function handleSteerPromptCompletion(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
): AcpStreamMessage[] | null {
  const promptId = (msg as { id?: string | number | null }).id;
  const steerPromptId = tracker.getSteerPromptId(sessionId);
  if (steerPromptId !== undefined && promptId === steerPromptId) {
    const originalPromptId = tracker.getActivePromptId(sessionId);
    tracker.clearSteerPrompt(sessionId);
    return [{ ...msg, id: originalPromptId ?? null }];
  }
  return null;
}

async function dispatchSteeringPrompt(
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
  context: InboundContext,
): Promise<boolean> {
  tracker.setSteerPending(sessionId, false);
  tracker.incrementSteerCount(sessionId);
  tracker.resetSignaturesForSteering(sessionId);

  const toolName = tracker.getLastToolName(sessionId) ?? "tool";
  const loopResult = tracker.getLastLoopResult(sessionId);
  const repetitions = loopResult?.repetitions ?? 3;

  const steeringText =
    `[Automated Steering]: You have repeatedly executed '${toolName}' (${repetitions} times consecutively with identical parameters) without progress. ` +
    `Is this expected? If you are polling or waiting on an external state change, explain what you are waiting for. Otherwise, please stop repeating this action, evaluate your findings, and try a different approach or report your status to the user.`;

  const newSteerPromptId = `steer_${sessionId}_${Date.now()}`;
  tracker.setSteerPromptId(sessionId, newSteerPromptId);

  try {
    await context.writeToChild({
      jsonrpc: "2.0",
      id: newSteerPromptId,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId,
        prompt: [{ type: "text", text: steeringText }],
      },
    } as unknown as AcpStreamMessage);
    return true;
  } catch (err) {
    console.error(`[refined-antigravity-acp] Failed to send automated steering prompt:`, err);
    return false;
  }
}

function extractCancelledResult(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
): Record<string, unknown> | null {
  if (!tracker.isLoopInterrupted(sessionId) || !("result" in msg)) return null;
  const res = msg.result as Record<string, unknown> | null;
  if (!res) return null;
  if (res.stopReason && res.stopReason !== STOP_REASONS.CANCELLED) return null;
  return res;
}

async function settleInterruptedPromptResponse(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
  context: InboundContext,
  options: RepetitiveToolLoopOptions,
): Promise<AcpStreamMessage[] | null> {
  if (!("result" in msg)) return null;

  const steerResult = handleSteerPromptCompletion(msg, sessionId, tracker);
  if (steerResult) return steerResult;

  const res = extractCancelledResult(msg, sessionId, tracker);
  if (!res) return null;

  const maxSteers = options.maxSteersPerTurn ?? 1;
  const canSteer =
    tracker.isSteerPending(sessionId) && tracker.getSteerCount(sessionId) < maxSteers;
  if (canSteer && (await dispatchSteeringPrompt(sessionId, tracker, context))) {
    return [];
  }

  tracker.startTurn(sessionId);
  return [{ ...msg, result: { ...res, stopReason: STOP_REASONS.END_TURN } }];
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
    await interruptLoopExecution(sessionId, toolCallId, toolName, loopResult, tracker, context);
    return [];
  }
  return null;
}

export function createRepetitiveToolLoopFix(options: RepetitiveToolLoopOptions = {}): AcpFix {
  const tracker = new RepetitiveToolLoopTracker();

  return {
    name: "repetitive-tool-loop",
    description:
      "Detects and steers repetitive tool calling cycles and autoregressive attractor loops without breaking polling",

    onOutbound(msg: AcpStreamMessage, _context: OutboundContext) {
      const sessionId = extractSessionId(msg);
      if (!sessionId) return msg;

      if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
        const promptId = (msg as { id?: string | number }).id;
        const promptText = extractPromptText(msg);
        tracker.startTurn(sessionId, promptId, promptText);
      } else if (isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
        tracker.clearSteerPrompt(sessionId);
      }

      return msg;
    },

    async onInbound(msg: AcpStreamMessage, context: InboundContext) {
      const sessionId = resolveSessionId(msg, tracker);
      if (!sessionId) return [msg];

      const settled = await settleInterruptedPromptResponse(
        msg,
        sessionId,
        tracker,
        context,
        options,
      );
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
