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
  isJsonRpcResponse,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
  type StderrContext,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";

import {
  extractSessionId,
  setFixData,
  getSession,
  getOrCreateSession,
} from "../../core/session-cache.js";
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

export function createPromptSettlementMessage(
  promptId: string | number,
  stopReason: string = STOP_REASONS.END_TURN,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id: promptId,
    result: {
      stopReason,
    },
  };
}

export interface SubagentInfo {
  id?: string | undefined;
  role?: string | undefined;
  prompt?: string | undefined;
  typeName?: string | undefined;
  conversationId?: string | undefined;
}

export interface TrackedSubagentInfo extends SubagentInfo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SubagentStatusReport {
  role?: string | undefined;
  type?: string | undefined;
  conversationId?: string | undefined;
  state?: string | undefined;
}

export function isSubagentCompletedState(state?: string): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === "idle" || s === "completed" || s === "done" || s === "finished";
}

function getStringProp(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function parseSubagentItem(item: unknown): SubagentInfo | null {
  if (!item || typeof item !== "object") return null;
  const s = item as Record<string, unknown>;
  const role = getStringProp(s, "Role", "role");
  const prompt = getStringProp(s, "Prompt", "prompt");
  const typeName = getStringProp(s, "TypeName", "typeName", "type");
  const conversationId = getStringProp(s, "conversationId", "ConversationId");
  const id = getStringProp(s, "id", "Id") ?? conversationId;
  return {
    id,
    role,
    prompt,
    typeName,
    conversationId,
  };
}

function hasSubagentProperties(rec: Record<string, unknown>): boolean {
  return (
    rec.Role !== undefined ||
    rec.role !== undefined ||
    rec.Prompt !== undefined ||
    rec.prompt !== undefined ||
    rec.TypeName !== undefined ||
    rec.typeName !== undefined ||
    rec.type !== undefined
  );
}

function parseSubagentsProperty(subs: unknown): unknown[] {
  if (typeof subs === "string") {
    try {
      const parsed = JSON.parse(subs);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(subs) ? subs : [];
}

function extractSubagentsArray(rawArgs: unknown): unknown[] {
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
  if (Array.isArray(obj)) return obj;
  const record = obj as Record<string, unknown>;
  const subs = parseSubagentsProperty(record.Subagents ?? record.subagents);
  if (subs.length > 0) return subs;
  return hasSubagentProperties(record) ? [record] : [];
}

export function parseSubagentsFromArgs(rawArgs: unknown): SubagentInfo[] {
  const subs = extractSubagentsArray(rawArgs);
  return subs.map(parseSubagentItem).filter((s): s is SubagentInfo => s !== null);
}

export function parseSubagentStatusReports(rawOutput: unknown): SubagentStatusReport[] {
  if (!rawOutput) return [];
  let text = "";
  if (typeof rawOutput === "string") {
    text = rawOutput;
  } else if (typeof rawOutput === "object") {
    try {
      text = JSON.stringify(rawOutput);
    } catch {
      return [];
    }
  }
  const startIdx = text.indexOf("[");
  const endIdx = text.lastIndexOf("]");
  if (startIdx === -1 || endIdx <= startIdx) return [];

  try {
    const parsed = JSON.parse(text.slice(startIdx, endIdx + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(mapSubagentReport);
  } catch {
    return [];
  }
}

function mapSubagentReport(item: Record<string, unknown>): SubagentStatusReport {
  return {
    role:
      typeof item.role === "string"
        ? item.role
        : typeof item.Role === "string"
          ? item.Role
          : undefined,
    type:
      typeof item.type === "string"
        ? item.type
        : typeof item.TypeName === "string"
          ? item.TypeName
          : undefined,
    conversationId:
      typeof item.conversationId === "string"
        ? item.conversationId
        : typeof item.ConversationId === "string"
          ? item.ConversationId
          : undefined,
    state:
      typeof item.state === "string"
        ? item.state
        : typeof item.State === "string"
          ? item.State
          : undefined,
  };
}

function isCompletionPhrasePresent(lowerText: string): boolean {
  return (
    lowerText.includes("complete") ||
    lowerText.includes("finished") ||
    lowerText.includes("idle") ||
    lowerText.includes("success") ||
    lowerText.includes("passed") ||
    lowerText.includes("verified")
  );
}

function matchSubagentByRoleOrPrompt(sub: TrackedSubagentInfo, lowerText: string): boolean {
  if (sub.role && sub.role.trim().length > 3) {
    const roleLower = sub.role.toLowerCase().trim();
    if (lowerText.includes(roleLower) && isCompletionPhrasePresent(lowerText)) {
      return true;
    }
  }

  if (sub.prompt) {
    const itemMatch = sub.prompt.match(/\bItem\s+(\d+)\b/i);
    if (itemMatch?.[1]) {
      const itemNum = itemMatch[1];
      const pattern1 = new RegExp(
        `\\bItem\\s+${itemNum}\\b[^.\\n]*\\b(complete|completed|finished|success|verified)\\b`,
        "i",
      );
      const pattern2 = new RegExp(`\\b(completed|finished|verified)\\s+Item\\s+${itemNum}\\b`, "i");
      return pattern1.test(lowerText) || pattern2.test(lowerText);
    }
  }

  return false;
}

export function detectCompletedSubagentsInText(
  text: string,
  trackedSubagents: TrackedSubagentInfo[],
): TrackedSubagentInfo[] {
  const completed: TrackedSubagentInfo[] = [];
  const lower = text.toLowerCase();

  for (const sub of trackedSubagents) {
    if (sub.status === "completed") continue;

    if (sub.conversationId && text.includes(sub.conversationId)) {
      if (isCompletionPhrasePresent(lower)) {
        completed.push(sub);
        continue;
      }
    }

    if (matchSubagentByRoleOrPrompt(sub, lower)) {
      completed.push(sub);
    }
  }

  return completed;
}

function extractDirectiveOrSentence(text: string): string {
  const directiveMatch = text.match(
    /(?:Your\s+(?:task|goal|objective)\s+is\s+to|Please|Goal:|Objective:|Task:)\s+([^\r\n]+)/i,
  );
  if (directiveMatch?.[1]) {
    return directiveMatch[1].trim();
  }
  const firstLine = text.split(/[\r\n]+/)[0]?.trim() ?? "";
  return firstLine.split(/(?<=[.!?])\s+/)[0]?.trim() ?? firstLine;
}

export function extractSubagentTitleFromPrompt(prompt: string): string | null {
  let text = prompt.trim();
  if (!text) return null;

  text = text.replace(/^(?:You are\s+(?:an?|working in)\b[^\n.!?]*[\n.!?]+\s*)+/i, "").trim();
  text = extractDirectiveOrSentence(text);

  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  text = text.replace(/[.:;,\s]+$/, "").trim();

  if (text.length > 55) {
    const truncated = text.slice(0, 52);
    const lastSpace = truncated.lastIndexOf(" ");
    text = (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "...";
  }

  return text.length > 0 ? text : null;
}

export function formatSubagentContent(info: SubagentInfo): string {
  if (info.role && info.role.trim()) {
    const role = info.role.trim();
    if (role.toLowerCase().startsWith("subagent:")) {
      return role;
    }
    return `Subagent: ${role}`;
  }
  if (info.typeName && info.typeName !== "self" && info.typeName !== "default") {
    return `Subagent: ${info.typeName}`;
  }
  if (info.prompt && info.prompt.trim()) {
    const title = extractSubagentTitleFromPrompt(info.prompt);
    if (title) {
      return `Subagent: ${title}`;
    }
  }
  return "Subagent: Background Task";
}

export interface BackgroundTaskInfo {
  desc: string;
  taskId?: string | undefined;
}

function parseTextIntent(rawIntent: string): string {
  const firstSentence = rawIntent.split(/(?<=[.!?])\s+/)[0] ?? rawIntent;
  const stripped = firstSentence
    .replace(/\s+(?:and|\bI\b|I'll|I will)\b.*/i, "")
    .replace(/[.:;,\s]+$/, "")
    .trim();
  if (!stripped) return "";
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return truncateText(capitalized, 55);
}

function parseExplicitBackgroundTasks(
  text: string,
  seenTaskIds: Set<string>,
): BackgroundTaskInfo[] {
  const launched: BackgroundTaskInfo[] = [];
  const p1 =
    /(?:launched|running|started)\s+`([^`]+)`\s+in\s+the\s+background(?:\s*\(task\s+`?([^`)\s]+)`?\))?/gi;
  for (const m of text.matchAll(p1)) {
    if (!m[1]) continue;
    let rawDesc = m[1].trim();
    let taskId = m[2]?.trim();
    if (taskId && taskId.includes("/")) taskId = taskId.split("/").pop();
    const taskIdMatch = rawDesc.match(/^(?:task-[\w-]+)$/i);
    if (taskIdMatch) {
      if (!taskId) taskId = taskIdMatch[0];
      rawDesc = "";
    }
    if (taskId) seenTaskIds.add(taskId);
    launched.push({ desc: rawDesc, taskId });
  }
  return launched;
}

export function detectLaunchedTasksInText(text: string): BackgroundTaskInfo[] {
  const seenTaskIds = new Set<string>();
  const launched = parseExplicitBackgroundTasks(text, seenTaskIds);

  const p2 =
    /(?:launched|running|started)\s+(?:task\s+)?`?(task-[\w-]+)`?(?:\s+in\s+the\s+background)?(?:\s+(?:to|for)\s+([^\r\n]+))?/gi;
  for (const m of text.matchAll(p2)) {
    const taskId = m[1]?.trim();
    if (!taskId || seenTaskIds.has(taskId)) continue;
    seenTaskIds.add(taskId);
    const desc = m[2] ? parseTextIntent(m[2].trim()) : "";
    launched.push({ desc, taskId });
  }

  const p3 = /(?:Added Background task:\s*`?(task-[\w-]+)`?)/gi;
  for (const m of text.matchAll(p3)) {
    const taskId = m[1]?.trim();
    if (taskId && !seenTaskIds.has(taskId)) {
      seenTaskIds.add(taskId);
      launched.push({ desc: "", taskId });
    }
  }

  return launched;
}

function appendReconstructedTask(content: string, seen: Set<string>, entries: PlanEntry[]): void {
  if (!seen.has(content)) {
    seen.add(content);
    entries.push({ content, priority: "high", status: "completed" });
  }
}

function processStepForReconstruction(
  step: unknown,
  seen: Set<string>,
  entries: PlanEntry[],
): void {
  const s = step as { kind?: string; name?: string; rawInputJson?: string; text?: string };
  if (s.kind === "tool_call" && s.name === TOOL_INVOKE_SUBAGENT && s.rawInputJson) {
    for (const sub of parseSubagentsFromArgs(s.rawInputJson)) {
      appendReconstructedTask(formatSubagentContent(sub), seen, entries);
    }
  }
  if (s.kind === "assistant" && s.text) {
    for (const t of detectLaunchedTasksInText(s.text)) {
      appendReconstructedTask(`Background task: ${t.desc}`, seen, entries);
    }
  }
}

export function reconstructPlanFromSteps(steps: readonly unknown[]): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const seenContent = new Set<string>();

  for (const step of steps) {
    processStepForReconstruction(step, seenContent, entries);
  }

  return entries;
}

interface SessionPlanTracker {
  entries: PlanEntry[];
  trackedSubagents: TrackedSubagentInfo[];
  recentText: string;
  hasEmittedWaitingPlan: boolean;
  isWaiting: boolean;
  seenToolCallIds: Set<string>;
  activeToolCalls: Map<string, string>;
  inFlightToolCallIds: Set<string>;
  taskIds: Map<string, string>;
  pendingPlan: PlanEntry[] | null;
  activePromptId?: string | number | undefined;
  hasAssistantMessage: boolean;
  settlementTimer: NodeJS.Timeout | null;
}

const MAX_TRACKED_SESSIONS = 100;

function applyReportToExistingSubagent(
  report: SubagentStatusReport,
  matched: TrackedSubagentInfo,
  tracker: SessionPlanTracker,
): boolean {
  if (report.conversationId && !matched.conversationId) {
    matched.conversationId = report.conversationId;
  }
  if (isSubagentCompletedState(report.state) && matched.status !== "completed") {
    matched.status = "completed";
    const entry = tracker.entries.find((e) => e.content === matched.content);
    if (entry) entry.status = "completed";
    return true;
  }
  return false;
}

function tryCompleteInProgressTracked(tracker: SessionPlanTracker, convId?: string): boolean {
  const inProg = tracker.trackedSubagents.find((s) => s.status !== "completed");
  if (!inProg) return false;
  if (convId && !inProg.conversationId) {
    inProg.conversationId = convId;
  }
  inProg.status = "completed";
  const entry = tracker.entries.find((e) => e.content === inProg.content);
  if (entry) entry.status = "completed";
  return true;
}

function findMatchingSubagent(
  report: SubagentStatusReport,
  tracker: SessionPlanTracker,
): TrackedSubagentInfo | undefined {
  let matched = tracker.trackedSubagents.find(
    (s) =>
      (report.conversationId && s.conversationId === report.conversationId) ||
      (report.role && s.role && s.role.trim().toLowerCase() === report.role.trim().toLowerCase()),
  );
  if (!matched && report.conversationId) {
    matched = tracker.trackedSubagents.find((s) => !s.conversationId);
    if (matched) {
      matched.conversationId = report.conversationId;
    }
  }
  return matched;
}

function applyReportToTracker(report: SubagentStatusReport, tracker: SessionPlanTracker): boolean {
  const isDone = isSubagentCompletedState(report.state);
  const matched = findMatchingSubagent(report, tracker);
  if (matched) {
    return applyReportToExistingSubagent(report, matched, tracker);
  }

  if (!report.role && !report.type && tracker.trackedSubagents.length > 0) {
    return isDone ? tryCompleteInProgressTracked(tracker, report.conversationId) : false;
  }

  const subInfo: SubagentInfo = {
    role: report.role,
    typeName: report.type,
    conversationId: report.conversationId,
  };
  const content = formatSubagentContent(subInfo);
  const status = isDone ? "completed" : "in_progress";
  tracker.trackedSubagents.push({ ...subInfo, content, status });
  tracker.entries.push({ content, priority: "high", status });
  return true;
}

function isTaskMatchingEntry(
  entry: PlanEntry,
  taskId?: string,
  totalEntries = 0,
  taskIds?: Map<string, string>,
): boolean {
  if (entry.status === "completed" || !entry.content.startsWith("Background task:")) {
    return false;
  }
  if (!taskId) return true;
  if (entry.content.includes(taskId)) return true;
  if (taskIds?.get(taskId) === entry.content) return true;
  return totalEntries === 1;
}

function extractFinishedTaskId(rawOutput: string): string | undefined {
  if (!rawOutput.includes("finished with result:") && !rawOutput.includes("exited with code")) {
    return undefined;
  }
  const match = rawOutput.match(/Task id ["']?([^"'\s]+)["']?\s+finished/i);
  let taskId = match?.[1];
  if (taskId && taskId.includes("/")) {
    taskId = taskId.split("/").pop();
  }
  return taskId;
}

function updateSubagentsFromText(tracker: SessionPlanTracker, text: string): boolean {
  if (tracker.trackedSubagents.length === 0) return false;
  tracker.recentText = `${tracker.recentText} ${text}`.slice(-3000);
  const completed = detectCompletedSubagentsInText(tracker.recentText, tracker.trackedSubagents);
  let changed = false;
  for (const sub of completed) {
    if (sub.status !== "completed") {
      sub.status = "completed";
      const entry = tracker.entries.find((e) => e.content === sub.content);
      if (entry) entry.status = "completed";
      changed = true;
    }
  }
  return changed;
}

function registerLaunchedTasksFromText(tracker: SessionPlanTracker, text: string): boolean {
  let changed = false;
  for (const t of detectLaunchedTasksInText(text)) {
    if (t.taskId && tracker.taskIds.has(t.taskId)) {
      continue;
    }

    let content: string | undefined;
    if (t.desc) {
      content = `Background task: ${t.desc}`;
    } else if (t.taskId) {
      content = `Background task: ${t.taskId}`;
    }

    if (
      content &&
      !tracker.entries.some(
        (e) => e.content === content || (t.taskId && e.content.includes(t.taskId)),
      )
    ) {
      tracker.entries.push({ content, priority: "high", status: "in_progress" });
      if (t.taskId) tracker.taskIds.set(t.taskId, content);
      changed = true;
    }
  }
  return changed;
}

export class BackgroundTasksTracker {
  private readonly sessions = new Map<string, SessionPlanTracker>();
  private readonly promptIdToSessionId = new Map<string | number, string>();
  private readonly settledPromptIds = new Set<string | number>();
  private forwardInbound?: ((msg: AcpStreamMessage) => void) | undefined;

  private getOrCreate(sessionId: string): SessionPlanTracker {
    let tracker = this.sessions.get(sessionId);
    if (!tracker) {
      if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      tracker = {
        entries: [],
        trackedSubagents: [],
        recentText: "",
        hasEmittedWaitingPlan: false,
        isWaiting: false,
        seenToolCallIds: new Set<string>(),
        activeToolCalls: new Map<string, string>(),
        inFlightToolCallIds: new Set<string>(),
        taskIds: new Map<string, string>(),
        pendingPlan: null,
        activePromptId: undefined,
        hasAssistantMessage: false,
        settlementTimer: null,
      };
      this.sessions.set(sessionId, tracker);
    }
    return tracker;
  }

  setForwardInbound(fn: (msg: AcpStreamMessage) => void): void {
    this.forwardInbound = fn;
  }

  getEntries(sessionId: string): readonly PlanEntry[] {
    return this.sessions.get(sessionId)?.entries ?? [];
  }

  hasActiveTasksOrSubagents(sessionId: string): boolean {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return false;
    return (
      tracker.isWaiting ||
      tracker.trackedSubagents.length > 0 ||
      tracker.entries.some((e) => e.status !== "completed")
    );
  }

  setPendingPlan(sessionId: string, entries: PlanEntry[]): void {
    this.getOrCreate(sessionId).pendingPlan = entries;
  }

  flushPendingPlan(sessionId: string): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || !tracker.pendingPlan) return null;
    const plan = tracker.pendingPlan;
    tracker.pendingPlan = null;
    return createPlanUpdateMessage(sessionId, plan);
  }

  onPromptStart(sessionId: string, promptId?: string | number | undefined): void {
    if (promptId !== undefined) {
      this.promptIdToSessionId.set(promptId, sessionId);
    }
    const tracker = this.getOrCreate(sessionId);
    if (tracker.settlementTimer) {
      clearTimeout(tracker.settlementTimer);
      tracker.settlementTimer = null;
    }
    tracker.activePromptId = promptId;
    tracker.hasAssistantMessage = false;
    tracker.inFlightToolCallIds.clear();
    const activeEntries = tracker.entries.filter((e) => e.status !== "completed");
    tracker.entries = activeEntries;
    tracker.trackedSubagents = tracker.trackedSubagents.filter((s) => s.status !== "completed");
    tracker.recentText = "";
    tracker.hasEmittedWaitingPlan = false;
    tracker.isWaiting = activeEntries.length > 0;
    tracker.pendingPlan = null;
    tracker.seenToolCallIds.clear();
    tracker.activeToolCalls.clear();
    tracker.taskIds.clear();
  }

  recordTaskId(sessionId: string, taskId: string, content: string): void {
    let id = taskId;
    if (id.includes("/")) {
      id = id.split("/").pop() ?? id;
    }
    this.getOrCreate(sessionId).taskIds.set(id, content);
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

  onAssistantChunk(sessionId: string): void {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return;
    tracker.hasAssistantMessage = true;
    if (tracker.settlementTimer) {
      clearTimeout(tracker.settlementTimer);
      tracker.settlementTimer = null;
    }
  }

  onToolCallStart(sessionId: string, toolCallId?: string): void {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return;
    if (toolCallId) {
      tracker.inFlightToolCallIds.add(toolCallId);
    }
    if (tracker.settlementTimer) {
      clearTimeout(tracker.settlementTimer);
      tracker.settlementTimer = null;
    }
  }

  onToolCallEnd(sessionId: string, toolCallId?: string): void {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || !toolCallId) return;
    tracker.inFlightToolCallIds.delete(toolCallId);
  }

  isPromptSettled(promptId: string | number): boolean {
    return this.settledPromptIds.has(promptId);
  }

  clearPromptSettled(promptId: string | number): void {
    this.settledPromptIds.delete(promptId);
  }

  clearSettlementTimer(sessionId: string): void {
    const tracker = this.sessions.get(sessionId);
    if (tracker?.settlementTimer) {
      clearTimeout(tracker.settlementTimer);
      tracker.settlementTimer = null;
    }
  }

  clearActivePromptId(sessionId: string): void {
    const tracker = this.sessions.get(sessionId);
    if (tracker) {
      tracker.activePromptId = undefined;
    }
  }

  canSettlePrompt(sessionId: string): boolean {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return false;
    if (tracker.activePromptId === undefined || tracker.activePromptId === null) return false;
    if (this.settledPromptIds.has(tracker.activePromptId)) return false;
    if (!tracker.hasAssistantMessage) return false;
    if (tracker.inFlightToolCallIds.size > 0) return false;
    return (
      tracker.isWaiting ||
      tracker.trackedSubagents.length > 0 ||
      tracker.entries.some((e) => e.status !== "completed")
    );
  }

  armSettlementTimer(sessionId: string, delayMs = 50): void {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || tracker.settlementTimer) return;
    tracker.settlementTimer = setTimeout(() => {
      tracker.settlementTimer = null;
      if (!this.canSettlePrompt(sessionId)) return;
      const promptId = tracker.activePromptId;
      if (promptId === undefined || promptId === null) return;
      tracker.activePromptId = undefined;
      this.settledPromptIds.add(promptId);
      if (this.settledPromptIds.size > 200) {
        const first = this.settledPromptIds.values().next().value;
        if (first !== undefined) this.settledPromptIds.delete(first);
      }
      const settlementMsg = createPromptSettlementMessage(promptId);
      this.forwardInbound?.(settlementMsg);
    }, delayMs);
    tracker.settlementTimer.unref?.();
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

    for (const s of subagents) {
      const content = formatSubagentContent(s);
      const existing = tracker.trackedSubagents.find(
        (t) =>
          t.content === content ||
          (s.role && t.role && t.role.trim().toLowerCase() === s.role.trim().toLowerCase()),
      );
      if (existing) {
        if (s.conversationId && !existing.conversationId) {
          existing.conversationId = s.conversationId;
        }
        continue;
      }

      tracker.trackedSubagents.push({
        ...s,
        content,
        status: "in_progress",
      });
      tracker.entries.push({
        content,
        priority: "high",
        status: "in_progress",
      });
    }

    return tracker.entries;
  }

  updateFromManageSubagents(sessionId: string, rawOutput: unknown): PlanEntry[] | null {
    const reports = parseSubagentStatusReports(rawOutput);
    if (reports.length === 0) return null;
    const tracker = this.getOrCreate(sessionId);
    let changed = false;

    for (const report of reports) {
      if (applyReportToTracker(report, tracker)) {
        changed = true;
      }
    }

    if (changed && !tracker.entries.some((e) => e.status !== "completed")) {
      tracker.isWaiting = false;
    }

    return changed ? tracker.entries : null;
  }

  updateFromText(sessionId: string, text: string): PlanEntry[] | null {
    const tracker = this.getOrCreate(sessionId);

    let changed = Boolean(this.updateFromManageTask(sessionId, text));
    if (registerLaunchedTasksFromText(tracker, text)) changed = true;
    if (updateSubagentsFromText(tracker, text)) changed = true;

    if (changed && !tracker.entries.some((e) => e.status !== "completed")) {
      tracker.isWaiting = false;
    }

    return changed ? tracker.entries : null;
  }

  updateFromManageTask(sessionId: string, rawOutput: unknown): PlanEntry[] | null {
    if (typeof rawOutput !== "string") return null;
    const taskId = extractFinishedTaskId(rawOutput);
    if (taskId === undefined && !rawOutput.includes("finished with result:")) {
      return null;
    }
    const tracker = this.getOrCreate(sessionId);

    let changed = false;
    for (const entry of tracker.entries) {
      if (isTaskMatchingEntry(entry, taskId, tracker.entries.length, tracker.taskIds)) {
        entry.status = "completed";
        changed = true;
      }
    }

    if (changed && !tracker.entries.some((e) => e.status !== "completed")) {
      tracker.isWaiting = false;
    }

    return changed ? tracker.entries : null;
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
        if (entry.status !== "completed") {
          entry.status = "in_progress";
        }
      }
    }

    if (this.canSettlePrompt(sessionId)) {
      this.armSettlementTimer(sessionId);
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
    if (tracker.trackedSubagents.length > 0) {
      return null;
    }

    for (const entry of tracker.entries) {
      entry.status = "completed";
    }

    return createPlanUpdateMessage(sessionId, tracker.entries);
  }

  onIdle(sessionId: string, _context?: StderrContext | undefined): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker || tracker.entries.length === 0) {
      return null;
    }

    tracker.isWaiting = false;
    tracker.hasEmittedWaitingPlan = false;
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }

    return createPlanUpdateMessage(sessionId, tracker.entries);
  }

  onCancel(sessionId: string): {
    planMsg: AcpStreamMessage | null;
    cancelPromptMsg: AcpStreamMessage | null;
  } {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return { planMsg: null, cancelPromptMsg: null };
    this.clearSettlementTimer(sessionId);
    this.clearActivePromptId(sessionId);
    tracker.isWaiting = false;
    tracker.pendingPlan = null;
    for (const entry of tracker.entries) {
      entry.status = "completed";
    }
    const planMsg =
      tracker.entries.length > 0 ? createPlanUpdateMessage(sessionId, tracker.entries) : null;
    return { planMsg, cancelPromptMsg: null };
  }

  onTurnEnd(sessionId: string): AcpStreamMessage | null {
    const tracker = this.sessions.get(sessionId);
    if (!tracker) return null;
    this.clearSettlementTimer(sessionId);
    if (tracker.entries.length === 0 || tracker.isWaiting) {
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
    for (const tracker of this.sessions.values()) {
      if (tracker.settlementTimer) {
        clearTimeout(tracker.settlementTimer);
        tracker.settlementTimer = null;
      }
    }
    this.sessions.clear();
    this.promptIdToSessionId.clear();
    this.settledPromptIds.clear();
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

function isSubagentRawObject(obj: Record<string, unknown>): boolean {
  return (
    "Subagents" in obj ||
    "subagents" in obj ||
    "Role" in obj ||
    "role" in obj ||
    "TypeName" in obj ||
    "typeName" in obj
  );
}

function inferFromRawInput(rawInput: unknown): string | null {
  const obj = parseRawInputObject(rawInput);
  if (!obj) return null;
  if (isSubagentRawObject(obj)) return TOOL_INVOKE_SUBAGENT;
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

function extractParsedArgs(rawArgs: unknown): Record<string, unknown> | null {
  if (!rawArgs) return null;
  if (typeof rawArgs === "string") {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : null;
}

function truncateText(text: string, maxLen = 60): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 3)}...` : trimmed;
}

function extractScheduleDesc(args: Record<string, unknown>): string | undefined {
  const fields = [args.toolSummary, args.toolAction, args.Prompt, args.prompt];
  for (const field of fields) {
    if (typeof field === "string") {
      const trimmed = field.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function extractScheduleDuration(args: Record<string, unknown>): string | undefined {
  const dur = args.DurationSeconds;
  if (typeof dur === "number" || typeof dur === "string") {
    return `${dur}s`;
  }
  return undefined;
}

function extractScheduleCron(args: Record<string, unknown>): string | undefined {
  const cron = args.CronExpression;
  if (typeof cron === "string") {
    const trimmed = cron.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function formatScheduleTask(rawArgs: unknown): string {
  const args = extractParsedArgs(rawArgs);
  if (!args) return "Timer";

  const desc = extractScheduleDesc(args);
  const duration = extractScheduleDuration(args);
  const cron = extractScheduleCron(args);

  if (cron) {
    return desc ? `Recurring: ${truncateText(desc)} (${cron})` : `Recurring: ${cron}`;
  }
  if (desc && duration) {
    return `Timer (${duration}): ${truncateText(desc)}`;
  }
  if (desc) {
    return `Timer: ${truncateText(desc)}`;
  }
  if (duration) {
    return `Timer: Wait ${duration}`;
  }
  return "Timer";
}

function extractCommandLine(rawArgs: unknown): string | null {
  const obj = extractParsedArgs(rawArgs);
  if (!obj) return null;
  if (typeof obj.toolSummary === "string" && obj.toolSummary.trim()) {
    return truncateText(obj.toolSummary);
  }
  if (typeof obj.toolAction === "string" && obj.toolAction.trim()) {
    return truncateText(obj.toolAction);
  }
  if (typeof obj.CommandLine === "string" && obj.CommandLine.trim()) {
    return truncateText(obj.CommandLine);
  }
  return null;
}

function extractTaskDescFromText(text: string, storedCommand?: string): string {
  const match = text.match(/Task Description:\s*([^\n\r]+)/i);
  let desc = match?.[1]?.trim() || storedCommand || "command";
  if (desc.startsWith('"') && desc.endsWith('"')) {
    desc = desc.slice(1, -1);
  }
  return desc;
}

function extractTaskIdFromText(text: string): string | undefined {
  const idMatch = text.match(/task id:\s*([^\s\n\r]+)/i);
  let taskId = idMatch?.[1]?.trim();
  if (taskId && taskId.includes("/")) {
    taskId = taskId.split("/").pop();
  }
  return taskId;
}

function isBackgroundTaskOutput(text: string): boolean {
  return (
    text.includes("Tool is running as a background task") ||
    text.includes("is running as a background task") ||
    text.includes("task id:")
  );
}

export function extractBackgroundTaskInfo(
  rawOutput: unknown,
  _toolCallId?: string | undefined,
  storedCommand?: string | undefined,
): BackgroundTaskInfo | null {
  const text = typeof rawOutput === "string" ? rawOutput : extractContentText(rawOutput);
  if (!text || !isBackgroundTaskOutput(text)) return null;

  return {
    desc: extractTaskDescFromText(text, storedCommand),
    taskId: extractTaskIdFromText(text),
  };
}

export function extractBackgroundTaskDescription(
  rawOutput: unknown,
  toolCallId?: string | undefined,
  storedCommand?: string | undefined,
): string | null {
  return extractBackgroundTaskInfo(rawOutput, toolCallId, storedCommand)?.desc ?? null;
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
    if (tracker.hasActiveTasksOrSubagents(sessionId)) {
      return null;
    }
    const taskName = formatScheduleTask(toolArgs);
    if (taskName === "Timer" || taskName.startsWith("Timer: Wait")) {
      return null;
    }
    const prevCount = tracker.getEntries(sessionId).length;
    const entries = tracker.recordCustomTask(sessionId, taskName, "medium", toolCallId);
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
    const text = getPayloadText(u);
    const storedCmd = u.toolCallId ? tracker.getToolCommand(sessionId, u.toolCallId) : undefined;
    const bgInfo = extractBackgroundTaskInfo(text, u.toolCallId, storedCmd);
    if (bgInfo) {
      const content = `Background task: ${bgInfo.desc}`;
      const entries = tracker.recordCustomTask(sessionId, content, "high", u.toolCallId);
      if (bgInfo.taskId) {
        tracker.recordTaskId(sessionId, bgInfo.taskId, content);
      }
      tracker.setWaiting(sessionId, true);
      return entries;
    }
  }
  return null;
}

function extractDeltaText(delta: unknown): string | null {
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

function extractItemText(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const t = (item as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return null;
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map(extractItemText).filter((t): t is string => Boolean(t));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return extractItemText(content);
}

function getPayloadText(u: SessionUpdatePayload): string | null {
  if (typeof u.rawOutput === "string") return u.rawOutput;
  if (u.rawOutput && typeof u.rawOutput === "object") {
    try {
      return JSON.stringify(u.rawOutput);
    } catch {}
  }
  return extractContentText(u.content);
}

function extractUpdateText(msg: AcpStreamMessage): string | null {
  if (!("params" in msg) || !msg.params) return null;
  const p = (msg.params as SessionUpdateParams | undefined)?.update;
  if (!p) return null;
  return (
    extractContentText(p.content) ??
    extractDeltaText((p as { delta?: unknown }).delta) ??
    (typeof p.rawOutput === "string" ? p.rawOutput : null)
  );
}

function processToolCallUpdate(
  sessionId: string,
  u: SessionUpdatePayload,
  tracker: BackgroundTasksTracker,
): PlanEntry[] | null {
  if (u.sessionUpdate !== SESSION_UPDATES.TOOL_CALL_UPDATE) {
    return null;
  }
  const text = getPayloadText(u);
  if (!text) return null;

  const subEntries = tracker.updateFromManageSubagents(sessionId, text);
  if (subEntries) return subEntries;

  const taskEntries = tracker.updateFromManageTask(sessionId, text);
  if (taskEntries) return taskEntries;

  return tracker.updateFromText(sessionId, text);
}

function processInboundToolCall(
  sessionId: string,
  u: SessionUpdatePayload,
  tracker: BackgroundTasksTracker,
): PlanEntry[] | null {
  const bgEntries = handleToolCallState(sessionId, u, tracker);
  if (bgEntries) return bgEntries;

  const updatedPlan = processToolCallUpdate(sessionId, u, tracker);
  if (updatedPlan) return updatedPlan;

  const toolArgs = u.rawInput ?? u.arguments;
  const toolName = inferToolName(u.name ?? undefined, u.title ?? undefined, toolArgs);
  if (!toolName) return null;

  return handleInboundToolCall(sessionId, toolName, toolArgs, tracker, u.toolCallId);
}

function processInboundSessionUpdate(
  msg: AcpStreamMessage,
  sessionId: string,
  tracker: BackgroundTasksTracker,
): PlanEntry[] | null {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return null;
  const text = extractUpdateText(msg);
  return text ? tracker.updateFromText(sessionId, text) : null;
}

function handleInboundResponse(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
): AcpStreamMessage[] | null {
  if (!isJsonRpcResponse(msg)) return null;
  const id = msg.id;
  if (id === undefined || id === null) return [msg];

  if (tracker.isPromptSettled(id)) {
    tracker.clearPromptSettled(id);
    return [];
  }
  const sessionId = tracker.getSessionForPromptId(id);
  if (sessionId) {
    tracker.clearSettlementTimer(sessionId);
    tracker.clearActivePromptId(sessionId);
  }
  return [msg];
}

function handleAssistantStreamState(
  sessionId: string,
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
): void {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return;
  const u = (msg.params as SessionUpdateParams | undefined)?.update;
  if (!u) return;

  if (
    u.sessionUpdate === SESSION_UPDATES.AGENT_MESSAGE_CHUNK ||
    u.sessionUpdate === SESSION_UPDATES.AGENT_THOUGHT_CHUNK
  ) {
    tracker.onAssistantChunk(sessionId);
  } else if (u.sessionUpdate === SESSION_UPDATES.USAGE_UPDATE) {
    if (tracker.canSettlePrompt(sessionId)) {
      tracker.armSettlementTimer(sessionId);
    }
  }
}

function handleToolCallStreamState(
  extracted: { sessionId: string; update: SessionUpdatePayload },
  tracker: BackgroundTasksTracker,
): void {
  const { sessionId, update } = extracted;
  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL) {
    tracker.onToolCallStart(sessionId, update.toolCallId);
    return;
  }
  if (update.sessionUpdate === SESSION_UPDATES.TOOL_CALL_UPDATE) {
    const isDone = update.status === "completed" || update.status === "failed";
    const text = getPayloadText(update);
    const isBg = text ? isBackgroundTaskOutput(text) : false;
    if (isDone || isBg) {
      tracker.onToolCallEnd(sessionId, update.toolCallId);
    }
  }
}

function processInbound(
  msg: AcpStreamMessage,
  tracker: BackgroundTasksTracker,
  context?: InboundContext | undefined,
): AcpStreamMessage[] {
  const responseResult = handleInboundResponse(msg, tracker);
  if (responseResult) return responseResult;

  const sessionId = extractSessionId(msg) ?? context?.session?.sessionId;
  if (sessionId) {
    handleAssistantStreamState(sessionId, msg, tracker);
  }

  const extracted = extractToolCallUpdate(msg);
  if (extracted) {
    handleToolCallStreamState(extracted, tracker);
    const plan = processInboundToolCall(extracted.sessionId, extracted.update, tracker);
    return plan ? [msg, createPlanUpdateMessage(extracted.sessionId, plan)] : [msg];
  }

  if (sessionId) {
    const plan = processInboundSessionUpdate(msg, sessionId, tracker);
    if (plan) return [msg, createPlanUpdateMessage(sessionId, plan)];
  }

  return [msg];
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
  const hadActiveTasks = tracker.hasActiveTasksOrSubagents(sessionId);
  const { planMsg, cancelPromptMsg } = tracker.onCancel(sessionId);
  if (planMsg) context.forwardInbound?.(planMsg);
  if (cancelPromptMsg) forwardCancelPromptMsg(cancelPromptMsg, context);

  const session =
    context.session ??
    (context.sessionCache ? getSession(context.sessionCache, sessionId) : undefined);
  if (hadActiveTasks) {
    const targetSession =
      session ??
      (context.sessionCache ? getOrCreateSession(context.sessionCache, sessionId) : undefined);
    if (targetSession) {
      targetSession.needsRecycle = true;
      setFixData(targetSession, "hadActiveTasksOnCancel", true);
    }
  }
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
      if (context.forwardInbound) {
        tracker.setForwardInbound(context.forwardInbound);
      }
      return handleOutbound(msg, tracker, context);
    },

    onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
      if (context.forwardInbound) {
        tracker.setForwardInbound(context.forwardInbound);
      }
      return processInbound(msg, tracker, context);
    },

    onStderrLine(line: string, context: StderrContext): boolean {
      if (context.forwardInbound) {
        tracker.setForwardInbound(context.forwardInbound);
      }
      return processStderrLine(line, tracker, context);
    },

    onTurnEnd(sessionId: string, _context: InboundContext): AcpStreamMessage[] {
      const pendingPlan = tracker.flushPendingPlan(sessionId);
      const planMsg = tracker.onTurnEnd(sessionId);
      const messages: AcpStreamMessage[] = [];
      if (pendingPlan) messages.push(pendingPlan);
      if (planMsg && (!pendingPlan || planMsg !== pendingPlan)) messages.push(planMsg);
      return messages;
    },

    dispose(): void {
      tracker.dispose();
    },
  };
}

export const silentBackgroundTasksFix = createSilentBackgroundTasksFix();
export const createBackgroundTasksFix = createSilentBackgroundTasksFix;
export const backgroundTasksFix = silentBackgroundTasksFix;
