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
import { extractSessionId, trackPendingRequestSession } from "../../core/session-cache.js";

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

export function normalizeCommandLine(cmd: string): string {
  const trimmed = cmd.trim();
  if (/^(?:\/bin\/|\/usr\/bin\/)?sleep\s+\d+(?:\.\d+)?s?$/i.test(trimmed)) {
    return "sleep <N>";
  }
  return trimmed;
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
    const normalizedKey = normalizeKey(k);
    let canonicalVal = canonicalizeValue(v);
    if (normalizedKey === "commandline" && typeof canonicalVal === "string") {
      canonicalVal = normalizeCommandLine(canonicalVal);
    }
    sortedObj[normalizedKey] = canonicalVal;
  }
  return sortedObj;
}

function isSubagentInput(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return "Subagents" in r || "subagents" in r || "Role" in r || "role" in r;
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
    const rec = rawInput as Record<string, unknown>;
    if ("CommandLine" in rec) return "run_command";
    if ("AbsolutePath" in rec) return "view_file";
    if (isSubagentInput(rawInput)) return "invoke_subagent";
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

const RESOURCE_PATH_KEYS = [
  "AbsolutePath",
  "TargetFile",
  "targetFile",
  "target_file",
  "filePath",
  "file_path",
  "path",
] as const;

function parseRawObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

export function extractTargetResource(rawInput: unknown): string | undefined {
  const obj = parseRawObject(rawInput);
  if (!obj) return undefined;
  for (const key of RESOURCE_PATH_KEYS) {
    const val = obj[key];
    if (typeof val === "string") return val;
  }
  return undefined;
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
  resourceSignatures: string[];
  loopInterrupted: boolean;
  steerPending: boolean;
  steerPromptId?: string | number | undefined;
  steerCount: number;
  clientCancelled?: boolean;
  lastLoopResult?: CycleDetectionResult | undefined;
  lastToolName?: string | undefined;
  lastTargetResource?: string | undefined;
}

export const DEFAULT_READ_ONLY_SINGLE_THRESHOLD = 15;
export const DEFAULT_MUTATING_SINGLE_THRESHOLD = 10;
export const DEFAULT_CYCLE_THRESHOLD = 4;
export const DEFAULT_RESOURCE_LOOP_THRESHOLD = 25;

function resolveSingleThreshold(
  isReadOnly: boolean,
  hasPolling: boolean,
  requestedIterations: number | undefined,
  options: RepetitiveToolLoopOptions,
): number {
  if (isReadOnly) return options.readOnlySingleThreshold ?? DEFAULT_READ_ONLY_SINGLE_THRESHOLD;
  if (!hasPolling) return options.mutatingSingleThreshold ?? DEFAULT_MUTATING_SINGLE_THRESHOLD;
  const basePolling = options.pollingSingleThreshold ?? 30;
  return requestedIterations ? Math.max(requestedIterations + 2, basePolling) : basePolling;
}

function detectResourceLoop(
  state: SessionTurnState,
  toolName: string,
  rawInput: unknown,
  singleThreshold: number,
  options: RepetitiveToolLoopOptions,
): CycleDetectionResult | null {
  if (!READ_ONLY_TOOLS.has(toolName)) return null;
  const resource = extractTargetResource(rawInput);
  if (!resource) return null;
  state.resourceSignatures.push(`${toolName}:${resource}`);
  const resourceThreshold = state.hasPollingIntent
    ? singleThreshold
    : options.readOnlySingleThreshold !== undefined
      ? options.readOnlySingleThreshold * 2
      : DEFAULT_RESOURCE_LOOP_THRESHOLD;
  const resCycle = detectCycle(state.resourceSignatures, {
    maxPeriod: options.maxPeriod ?? 4,
    singleToolThreshold: resourceThreshold,
    cycleThreshold: options.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD,
  });
  if (resCycle.isLoop) {
    state.lastTargetResource = resource;
    return resCycle;
  }
  return null;
}

export class RepetitiveToolLoopTracker {
  private readonly sessions = new Map<string, SessionTurnState>();
  private readonly promptIdToSessionId = new Map<string | number, string>();

  private getOrCreate(sessionId: string): SessionTurnState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        signatures: [],
        resourceSignatures: [],
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
    state.resourceSignatures = [];
    state.loopInterrupted = false;
    state.steerPending = false;
    state.steerPromptId = undefined;
    state.steerCount = 0;
    state.clientCancelled = false;
    state.lastLoopResult = undefined;
    state.lastToolName = undefined;
    state.lastTargetResource = undefined;
    if (promptId !== undefined && promptId !== null) {
      this.promptIdToSessionId.set(promptId, sessionId);
    }
  }

  isClientCancelled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.clientCancelled ?? false;
  }

  setClientCancelled(sessionId: string, cancelled: boolean): void {
    const s = this.sessions.get(sessionId);
    if (s) s.clientCancelled = cancelled;
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
    if (!isReadOnly) {
      // Mutating actions modify files or state; reset purely read inspection tracking
      state.resourceSignatures = [];
    }

    const singleThreshold = resolveSingleThreshold(
      isReadOnly,
      state.hasPollingIntent,
      state.requestedIterations,
      options,
    );

    const result = detectCycle(state.signatures, {
      maxPeriod: options.maxPeriod ?? 4,
      singleToolThreshold: singleThreshold,
      cycleThreshold: options.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD,
    });

    const loopResult = result.isLoop
      ? result
      : detectResourceLoop(state, toolName, rawInput, singleThreshold, options);

    if (loopResult && loopResult.isLoop) {
      state.loopInterrupted = true;
      state.lastLoopResult = loopResult;
      state.lastToolName = toolName;
      if (!state.lastTargetResource) {
        state.lastTargetResource = extractTargetResource(rawInput);
      }
      return loopResult;
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

  getLastTargetResource(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.lastTargetResource;
  }

  resetSignaturesForSteering(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.signatures = [];
      s.resourceSignatures = [];
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
    if (originalPromptId !== undefined && originalPromptId !== null) {
      return [{ ...msg, id: originalPromptId }];
    }
    return [];
  }
  return null;
}

export function buildSteeringText(
  toolName: string,
  targetResource: string | undefined,
  repetitions: number,
  steerCount: number,
): string {
  const targetDesc = targetResource ? ` on '${targetResource}'` : "";
  if (steerCount > 0) {
    return (
      `[Automated Steering]: You are still repeatedly executing '${toolName}'${targetDesc}. Repetition was halted again. ` +
      `Please proceed with a different action to advance your task.`
    );
  }
  const countDesc = repetitions > 1 ? ` (${repetitions} times)` : "";
  return (
    `[Automated Steering]: You have repeatedly executed '${toolName}'${targetDesc}${countDesc}. Repetition was halted. ` +
    `Please evaluate the information gathered so far and continue with the next step of your task.`
  );
}

async function dispatchSteeringPrompt(
  sessionId: string,
  tracker: RepetitiveToolLoopTracker,
  context: InboundContext,
): Promise<boolean> {
  tracker.setSteerPending(sessionId, false);
  const currentSteerCount = tracker.getSteerCount(sessionId);
  tracker.incrementSteerCount(sessionId);
  tracker.resetSignaturesForSteering(sessionId);

  const toolName = tracker.getLastToolName(sessionId) ?? "tool";
  const targetResource = tracker.getLastTargetResource(sessionId);
  const loopResult = tracker.getLastLoopResult(sessionId);
  const repetitions = loopResult?.repetitions ?? 3;

  const steeringText = buildSteeringText(toolName, targetResource, repetitions, currentSteerCount);

  const newSteerPromptId = `steer_${sessionId}_${Date.now()}`;
  tracker.setSteerPromptId(sessionId, newSteerPromptId);
  trackPendingRequestSession(context.sessionCache, newSteerPromptId, sessionId);

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
  const steerResult = handleSteerPromptCompletion(msg, sessionId, tracker);
  if (steerResult) return steerResult;

  if (!("result" in msg)) return null;

  const maxSteers = options.maxSteersPerTurn ?? 2;
  const isClientCancelled = tracker.isClientCancelled(sessionId);
  const canSteer =
    !isClientCancelled &&
    tracker.isSteerPending(sessionId) &&
    tracker.getSteerCount(sessionId) < maxSteers;
  if (canSteer && (await dispatchSteeringPrompt(sessionId, tracker, context))) {
    return [];
  }

  const res = extractCancelledResult(msg, sessionId, tracker);
  if (!res) return null;

  const stopReason = isClientCancelled ? STOP_REASONS.CANCELLED : STOP_REASONS.END_TURN;
  tracker.startTurn(sessionId);
  return [{ ...msg, result: { ...res, stopReason } }];
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
        // Do NOT clear steerPromptId here! If an automated steering prompt is currently executing,
        // cancelling will cause upstream to respond with { id: steerPromptId, result: { stopReason: "cancelled" } }.
        // We must preserve steerPromptId so handleSteerPromptCompletion can map it back to the client's
        // activePromptId and deliver a clean cancellation response instead of leaking an unknown steer_ ID to the client.
        tracker.setClientCancelled(sessionId, true);
        tracker.setSteerPending(sessionId, false);
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
