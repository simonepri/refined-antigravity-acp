/**
 * Problem:
 * Subagents and scheduled background tasks execute silently in the background. While the agent
 * transitions into `STATE_WAITING_FOR_TASKS`, upstream `agy_acp_server` produces no stdout updates,
 * leaving editor UIs completely frozen with no indication of ongoing background progress.
 *
 * Solution:
 * Tracks subagent invocations and background tasks via telemetry and stream events, synthesizing
 * standard ACP `session/update` notifications with `sessionUpdate: "plan"` to expose live status.
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
  type StderrContext,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";

import { extractSessionId, setFixData } from "../../core/session-cache.js";
import { TELEMETRY_STATES, parseTrajectoryStateUpdate } from "../../core/telemetry.js";

export const TOOL_INVOKE_SUBAGENT = "invoke_subagent";
export const TOOL_SCHEDULE = "schedule";
export const DEFAULT_WAITING_TASK_CONTENT = "Running background subagents and tasks";

export interface BackgroundTasksOptions {
  dbPathResolver?: ((sessionId: string) => string) | undefined;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export function createPlanUpdateMessage(sessionId: string, entries: PlanEntry[]): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.PLAN,
        entries,
      },
    },
  };
}

export interface SubagentInfo {
  role?: string | undefined;
  prompt?: string | undefined;
  typeName?: string | undefined;
}

function parseSubagentItem(item: unknown): SubagentInfo | null {
  if (!item || typeof item !== "object") return null;
  const s = item as { Role?: unknown; Prompt?: unknown; TypeName?: unknown };
  return {
    role: typeof s.Role === "string" ? s.Role : undefined,
    prompt: typeof s.Prompt === "string" ? s.Prompt : undefined,
    typeName: typeof s.TypeName === "string" ? s.TypeName : undefined,
  };
}

export function parseSubagentsFromArgs(rawArgs: unknown): SubagentInfo[] {
  if (!rawArgs) return [];
  let obj: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      obj = JSON.parse(rawArgs);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== "object") return [];
  const subs = (obj as { Subagents?: unknown }).Subagents;
  if (!Array.isArray(subs)) return [];
  return subs.map(parseSubagentItem).filter((s): s is SubagentInfo => s !== null);
}

export function formatSubagentContent(info: SubagentInfo): string {
  if (info.role) {
    return `Subagent: ${info.role}`;
  }
  if (info.typeName) {
    return `Subagent: ${info.typeName}`;
  }
  if (info.prompt) {
    const trimmed = info.prompt.trim();
    const shortPrompt = trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
    return `Subagent: ${shortPrompt}`;
  }
  return "Subagent: Background Task";
}

interface SessionPlanTracker {
  entries: PlanEntry[];
  hasEmittedWaitingPlan: boolean;
  isWaiting: boolean;
  seenToolCallIds: Set<string>;
  activeToolCalls: Map<string, string>;
  deferredPromptResponse: AcpStreamMessage | null;
}

const MAX_TRACKED_SESSIONS = 100;

export class BackgroundTasksTracker {
  private readonly sessions = new Map<string, SessionPlanTracker>();
  private readonly promptIdToSessionId = new Map<string | number, string>();

  private getOrCreate(sessionId: string): SessionPlanTracker {
    let tracker = this.sessions.get(sessionId);
    if (!tracker) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      tracker = {
        entries: [],
        hasEmittedWaitingPlan: false,
        isWaiting: false,
        seenToolCallIds: new Set<string>(),
        activeToolCalls: new Map<string, string>(),
        deferredPromptResponse: null,
      };
      this.sessions.set(sessionId, tracker);
    }
    return tracker;
  }

  getEntries(sessionId: string): readonly PlanEntry[] {
    return this.sessions.get(sessionId)?.entries ?? [];
  }

  onPromptStart(sessionId: string, promptId?: string | number | undefined): void {
    if (promptId !== undefined) {
      this.promptIdToSessionId.set(promptId, sessionId);
    }
    const tracker = this.getOrCreate(sessionId);
    tracker.entries = [];
    tracker.hasEmittedWaitingPlan = false;
    tracker.isWaiting = false;
    tracker.deferredPromptResponse = null;
    tracker.seenToolCallIds.clear();
    tracker.activeToolCalls.clear();
  }

  getSessionForPromptId(promptId: string | number): string | undefined {
    return this.promptIdToSessionId.get(promptId);
  }

  isWaitingForTasks(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isWaiting ?? false;
  }

  setWaiting(sessionId: string, waiting: boolean): void {
    this.getOrCreate(sessionId).isWaiting = waiting;
  }

  recordToolCommand(sessionId: string, toolCallId: string, command: string): void {
    this.getOrCreate(sessionId).activeToolCalls.set(toolCallId, command);
  }

  getToolCommand(sessionId: string, toolCallId: string): string | undefined {
    return this.sessions.get(sessionId)?.activeToolCalls.get(toolCallId);
  }

  deferPromptResponse(sessionId: string, response: AcpStreamMessage): void {
    this.getOrCreate(sessionId).deferredPromptResponse = response;
  }

  recordSubagents(sessionId: string, subagents: SubagentInfo[], toolCallId?: string): PlanEntry[] {
    if (subagents.length === 0) return [];
    const tracker = this.getOrCreate(sessionId);
    if (toolCallId && tracker.seenToolCallIds.has(toolCallId)) {
      return tracker.entries;
    }
    if (toolCallId) {
      tracker.seenToolCallIds.add(toolCallId);
    }
    const newEntries: PlanEntry[] = subagents.map((s) => ({
      content: formatSubagentContent(s),
      priority: "high",
      status: "in_progress",
    }));
    tracker.entries.push(...newEntries);
    return tracker.entries;
  }

  recordCustomTask(
    sessionId: string,
    content: string,
    priority: "high" | "medium" | "low" = "medium",
    toolCallId?: string,
  ): PlanEntry[] {
    const tracker = this.getOrCreate(sessionId);
    if (toolCallId && tracker.seenToolCallIds.has(toolCallId)) {
      return tracker.entries;
    }
    if (toolCallId) {
      tracker.seenToolCallIds.add(toolCallId);
    }
    tracker.entries.push({
      content,
      priority,
      status: "in_progress",
    });
    return tracker.entries;
  }

  onWaitingForTasks(sessionId: string): AcpStreamMessage | null {
    const tracker = this.getOrCreate(sessionId);
    tracker.isWaiting = true;
    if (tracker.entries.length === 0) {
      tracker.entries.push({
        content: DEFAULT_WAITING_TASK_CONTENT,
        priority: "high",
        status: "in_progress",
      });
    } else {
      for (const entry of tracker.entries) {
        entry.status = "in_progress";
      }
    }

    tracker.hasEmittedWaitingPlan = true;
    return createPlanUpdateMessage(sessionId, tracker.entries);
  }

  onRunning(sessionId: string): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || tracker.entries.length === 0) {
      return null;
    }

    const hasIncomplete = tracker.entries.some((e) => e.status !== "completed");
    if (!hasIncomplete && !tracker.hasEmittedWaitingPlan) {
      return null;
    }

    tracker.isWaiting = false;
    tracker.hasEmittedWaitingPlan = false;
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }

    return createPlanUpdateMessage(sessionId, tracker.entries);
  }

  onIdle(sessionId: string, context?: StderrContext | undefined): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || tracker.entries.length === 0) {
      if (tracker?.deferredPromptResponse && context) {
        const deferred = tracker.deferredPromptResponse;
        tracker.deferredPromptResponse = null;
        tracker.isWaiting = false;
        context.forwardInbound(deferred);
      }
      return null;
    }

    tracker.isWaiting = false;
    tracker.hasEmittedWaitingPlan = false;
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }

    const planMsg = createPlanUpdateMessage(sessionId, tracker.entries);
    if (tracker.deferredPromptResponse && context) {
      const deferred = tracker.deferredPromptResponse;
      tracker.deferredPromptResponse = null;
      context.forwardInbound(planMsg);
      context.forwardInbound(deferred);
      return null;
    }

    return planMsg;
  }

  onCancel(sessionId: string): {
    planMsg: AcpStreamMessage | null;
    cancelPromptMsg: AcpStreamMessage | null;
  } {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return { planMsg: null, cancelPromptMsg: null };
    tracker.isWaiting = false;
    let cancelPromptMsg: AcpStreamMessage | null = null;
    if (tracker.deferredPromptResponse && "id" in tracker.deferredPromptResponse) {
      cancelPromptMsg = {
        jsonrpc: "2.0",
        id: tracker.deferredPromptResponse.id,
        result: { stopReason: STOP_REASONS.CANCELLED },
      };
      tracker.deferredPromptResponse = null;
    }
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }
    const planMsg =
      tracker.entries.length > 0 ? createPlanUpdateMessage(sessionId, tracker.entries) : null;
    return { planMsg, cancelPromptMsg };
  }

  onTurnEnd(sessionId: string): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || tracker.entries.length === 0 || tracker.isWaiting) {
      return null;
    }

    const hasIncomplete = tracker.entries.some((e) => e.status !== "completed");
    if (!hasIncomplete && !tracker.hasEmittedWaitingPlan) {
      return null;
    }

    tracker.isWaiting = false;
    tracker.hasEmittedWaitingPlan = false;
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }

    return createPlanUpdateMessage(sessionId, tracker.entries);
  }

  dispose(): void {
    this.sessions.clear();
    this.promptIdToSessionId.clear();
  }
}

function inferFromTitle(title?: string): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  if (lower.includes(TOOL_INVOKE_SUBAGENT)) return TOOL_INVOKE_SUBAGENT;
  if (lower.includes(TOOL_SCHEDULE)) return TOOL_SCHEDULE;
  return null;
}

function parseRawInputObject(rawInput: unknown): Record<string, unknown> | null {
  if (rawInput && typeof rawInput === "object") return rawInput as Record<string, unknown>;
  if (typeof rawInput === "string") {
    try {
      const parsed = JSON.parse(rawInput);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {}
  }
  return null;
}

function inferFromRawInput(rawInput: unknown): string | null {
  const obj = parseRawInputObject(rawInput);
  if (!obj) return null;
  if ("Subagents" in obj) return TOOL_INVOKE_SUBAGENT;
  if ("Schedule" in obj || "DurationSeconds" in obj || "CronExpression" in obj)
    return TOOL_SCHEDULE;
  return null;
}

export function inferToolName(
  name?: string | null,
  title?: string | null,
  rawInput?: unknown,
): string | null {
  if (name === TOOL_INVOKE_SUBAGENT || name === TOOL_SCHEDULE) return name;
  return inferFromTitle(title ?? undefined) ?? inferFromRawInput(rawInput);
}

function extractSchedulePrompt(rawArgs: unknown): string {
  if (rawArgs && typeof rawArgs === "object") {
    const p = (rawArgs as { Prompt?: unknown }).Prompt;
    if (typeof p === "string" && p.trim()) return p.trim();
  }
  return "Timer";
}

function extractCommandLine(rawArgs: unknown): string | null {
  if (!rawArgs) return null;
  let obj: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      obj = JSON.parse(rawArgs);
    } catch {
      return null;
    }
  }
  if (obj && typeof obj === "object" && "CommandLine" in obj) {
    const cmd = (obj as { CommandLine?: unknown }).CommandLine;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
  }
  return null;
}

function extractBackgroundTaskDescription(
  rawOutput: unknown,
  _toolCallId?: string | undefined,
  storedCommand?: string | undefined,
): string | null {
  if (typeof rawOutput !== "string") return null;
  if (
    !rawOutput.includes("Tool is running as a background task") &&
    !rawOutput.includes("task id:")
  ) {
    return null;
  }
  const match = rawOutput.match(/Task Description:\s*([^\n\r]+)/i);
  let desc = match?.[1]?.trim() || storedCommand || "command";
  if (desc.startsWith('"') && desc.endsWith('"')) {
    desc = desc.slice(1, -1);
  }
  return desc;
}

function handleInboundToolCall(
  sessionId: string,
  toolName: string | undefined,
  toolArgs: unknown,
  tracker: BackgroundTasksTracker,
  toolCallId?: string,
): PlanEntry[] | null {
  if (toolName === TOOL_INVOKE_SUBAGENT) {
    const subagents = parseSubagentsFromArgs(toolArgs);
    const prevCount = tracker.getEntries(sessionId).length;
    const entries = tracker.recordSubagents(sessionId, subagents, toolCallId);
    tracker.setWaiting(sessionId, true);
    return entries.length > prevCount ? entries : null;
  }
  if (toolName === TOOL_SCHEDULE) {
    const prompt = extractSchedulePrompt(toolArgs);
    const prevCount = tracker.getEntries(sessionId).length;
    const entries = tracker.recordCustomTask(
      sessionId,
      `Scheduled task: ${prompt}`,
      "medium",
      toolCallId,
    );
    tracker.setWaiting(sessionId, true);
    return entries.length > prevCount ? entries : null;
  }
  return null;
}

function extractToolCallUpdate(
  msg: AcpStreamMessage,
): { sessionId: string; update: SessionUpdatePayload } | null {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return null;
  const sessionId = extractSessionId(msg);
  if (!sessionId) return null;
  const u = (msg.params as SessionUpdateParams | undefined)?.update;
  if (
    u?.sessionUpdate !== SESSION_UPDATES.TOOL_CALL &&
    u?.sessionUpdate !== SESSION_UPDATES.TOOL_CALL_UPDATE
  )
    return null;
  return { sessionId, update: u };
}

function extractResponseSessionId(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
  context?: InboundContext | undefined,
): string | undefined {
  if (!("id" in msg) || msg.id === null || msg.id === undefined) return undefined;
  return context?.session?.sessionId ?? tracker.getSessionForPromptId(msg.id);
}

function tryInterceptWaitingPromptResponse(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
  context?: InboundContext | undefined,
): boolean {
  const result = (msg as { result?: { stopReason?: unknown } }).result;
  if (result?.stopReason !== STOP_REASONS.END_TURN) return false;

  const sessionId = extractResponseSessionId(msg, tracker, context);
  if (!sessionId || !tracker.isWaitingForTasks(sessionId)) return false;

  tracker.deferPromptResponse(sessionId, msg);
  return true;
}

function handleToolCallState(
  sessionId: string,
  u: SessionUpdatePayload,
  tracker: BackgroundTasksTracker,
): PlanEntry[] | null {
  if (u.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    const cmd = extractCommandLine(u.rawInput ?? u.arguments);
    if (cmd && u.toolCallId) {
      tracker.recordToolCommand(sessionId, u.toolCallId, cmd);
    }
    return null;
  }

  if (u.sessionUpdate === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    const storedCmd = u.toolCallId ? tracker.getToolCommand(sessionId, u.toolCallId) : undefined;
    const bgDesc = extractBackgroundTaskDescription(u.rawOutput, u.toolCallId, storedCmd);
    if (bgDesc) {
      const entries = tracker.recordCustomTask(
        sessionId,
        `Background task: ${bgDesc}`,
        "high",
        u.toolCallId,
      );
      tracker.setWaiting(sessionId, true);
      return entries;
    }
  }
  return null;
}

function processInbound(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
  context?: InboundContext | undefined,
): AcpStreamMessage[] {
  if (tryInterceptWaitingPromptResponse(msg, tracker, context)) {
    return [];
  }

  const extracted = extractToolCallUpdate(msg);
  if (!extracted) return [msg];

  const { sessionId, update: u } = extracted;
  const bgEntries = handleToolCallState(sessionId, u, tracker);
  if (bgEntries) {
    return [msg, createPlanUpdateMessage(sessionId, bgEntries)];
  }

  const toolArgs = u.rawInput ?? u.arguments;
  const toolName = inferToolName(u.name ?? undefined, u.title ?? undefined, toolArgs);
  if (!toolName) return [msg];

  const entries = handleInboundToolCall(sessionId, toolName, toolArgs, tracker, u.toolCallId);
  return entries ? [msg, createPlanUpdateMessage(sessionId, entries)] : [msg];
}

function processStderrLine(
  line: string,
  tracker: BackgroundTasksTracker,
  context: StderrContext,
): boolean {
  const tsu = parseTrajectoryStateUpdate(line);
  if (!tsu) return false;

  let planMsg: AcpStreamMessage | null = null;
  if (tsu.state === TELEMETRY_STATES.WAITING_FOR_TASKS) {
    planMsg = tracker.onWaitingForTasks(tsu.trajectoryId);
  } else if (tsu.state === TELEMETRY_STATES.RUNNING) {
    planMsg = tracker.onRunning(tsu.trajectoryId);
  } else if (
    tsu.state === TELEMETRY_STATES.FULLY_IDLE ||
    tsu.state === TELEMETRY_STATES.COMPLETE ||
    tsu.state === TELEMETRY_STATES.IDLE
  ) {
    planMsg = tracker.onIdle(tsu.trajectoryId, context);
  }

  if (planMsg) {
    context.forwardInbound(planMsg);
  }
  return false;
}

function forwardCancelPromptMsg(cancelPromptMsg: AcpStreamMessage, context: OutboundContext): void {
  const id = (cancelPromptMsg as { id?: string | number | null }).id;
  if (context.session && id !== undefined && id !== null) {
    setFixData(context.session, "cancelPromptSettled", id);
  }
  context.forwardInbound?.(cancelPromptMsg);
}

function handleOutboundCancel(
  sessionId: string,
  tracker: BackgroundTasksTracker,
  context: OutboundContext,
): void {
  const { planMsg, cancelPromptMsg } = tracker.onCancel(sessionId);
  if (planMsg) context.forwardInbound?.(planMsg);
  if (cancelPromptMsg) forwardCancelPromptMsg(cancelPromptMsg, context);
}

function handleOutbound(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
  context: OutboundContext,
): AcpStreamMessage {
  const sessionId = extractSessionId(msg);
  if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
    const promptId = (msg as { id?: string | number }).id;
    if (sessionId) tracker.onPromptStart(sessionId, promptId);
  } else if (isMethod(msg, ACP_METHODS.SESSION_CANCEL)) {
    if (sessionId) handleOutboundCancel(sessionId, tracker, context);
  }
  return msg;
}

export function createSilentBackgroundTasksFix(
  _options?: BackgroundTasksOptions | undefined,
): AcpFix & { tracker: BackgroundTasksTracker } {
  const tracker = new BackgroundTasksTracker();

  return {
    name: "silent-background-tasks",
    description:
      "Exposes background subagents and scheduled tasks via synthesized ACP session/update plan notifications",
    tracker,

    onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
      return handleOutbound(msg, tracker, context);
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      return processInbound(msg, tracker, context);
    },

    onStderrLine(line: string, context: StderrContext): boolean {
      return processStderrLine(line, tracker, context);
    },

    onTurnEnd(sessionId: string, _context: InboundContext): AcpStreamMessage[] {
      const planMsg = tracker.onTurnEnd(sessionId);
      return planMsg ? [planMsg] : [];
    },

    dispose(): void {
      tracker.dispose();
    },
  };
}

export const silentBackgroundTasksFix = createSilentBackgroundTasksFix();
export const createBackgroundTasksFix = createSilentBackgroundTasksFix;
export const backgroundTasksFix = silentBackgroundTasksFix;
