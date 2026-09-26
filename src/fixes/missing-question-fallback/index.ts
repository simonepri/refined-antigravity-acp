/**
 * Problem:
 * When the model invokes `ask_question`, upstream `agy_acp_server` presents a `session/request_permission`
 * modal choice and pauses execution awaiting user input. If the user types a new message into the chat
 * or cancels instead of picking a pre-defined choice, upstream rejects the prompt with
 * `"A foreground turn is already active"`, causing the turn to deadlock indefinitely.
 *
 * Solution:
 * Tracks in-flight `ask_question` requests and unblocks upstream by auto-cancelling the pending
 * permission question when a new user chat prompt arrives, dismissing the UI question spinner and
 * allowing the user's message to execute immediately.
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

export const OTHER_OPTION_REGEX = /\b(?:other|none\s+of\s+the\s+above|something\s+else)\b/i;

export interface QuestionItem {
  question?: string;
  options?: string[];
  is_multi_select?: boolean;
  [key: string]: unknown;
}

export interface AskQuestionPayload {
  questions?: QuestionItem[];
  [key: string]: unknown;
}

interface PendingQuestionRequest {
  requestId: string | number;
  sessionId: string;
  toolCallId?: string | undefined;
}

function parsePayload(raw: unknown): { parsed: AskQuestionPayload | null; isString: boolean } {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? { parsed: parsed as AskQuestionPayload, isString: true }
        : { parsed: null, isString: true };
    } catch {
      return { parsed: null, isString: true };
    }
  }

  if (typeof raw === "object" && raw !== null) {
    return { parsed: raw as AskQuestionPayload, isString: false };
  }

  return { parsed: null, isString: false };
}

function appendOtherIfMissing(question: QuestionItem): boolean {
  if (!Array.isArray(question.options)) return false;
  const hasOther = question.options.some(
    (opt) => typeof opt === "string" && OTHER_OPTION_REGEX.test(opt),
  );
  if (hasOther) return false;
  question.options.push("Other");
  return true;
}

export function ensureOtherOption(raw: unknown): { modified: boolean; result: unknown } {
  if (!raw) return { modified: false, result: raw };

  const { parsed, isString } = parsePayload(raw);
  if (!parsed || !Array.isArray(parsed.questions)) {
    return { modified: false, result: raw };
  }

  let anyModified = false;
  for (const q of parsed.questions) {
    if (q && appendOtherIfMissing(q)) {
      anyModified = true;
    }
  }

  if (!anyModified) return { modified: false, result: raw };
  const finalResult = isString ? JSON.stringify(parsed) : parsed;
  return { modified: true, result: finalResult };
}

function patchFieldIfAskQuestion(container: Record<string, unknown>, field: string): void {
  const value = container[field];
  if (value === undefined) return;
  const { modified, result } = ensureOtherOption(value);
  if (modified) {
    container[field] = result;
  }
}

function isAskQuestionName(name?: string | null, title?: string | null): boolean {
  if (name === "ask_question") return true;
  return typeof title === "string" && title.toLowerCase().includes("ask_question");
}

function handleSessionUpdate(update: SessionUpdatePayload): void {
  const isToolCall =
    update.sessionUpdate === SESSION_UPDATES.TOOL_CALL ||
    update.sessionUpdate === SESSION_UPDATES.TOOL_CALL_UPDATE;
  if (!isToolCall) return;

  if (isAskQuestionName(update.name ?? undefined, update.title ?? undefined)) {
    patchFieldIfAskQuestion(update as Record<string, unknown>, "rawInput");
    patchFieldIfAskQuestion(update as Record<string, unknown>, "arguments");
  }
}

function handleRpcRequest(msg: AcpStreamMessage): void {
  if (!("method" in msg) || typeof msg.method !== "string") return;
  const isToolInvocation =
    msg.method === "tools/call" ||
    msg.method === ACP_METHODS.SESSION_REQUEST_PERMISSION ||
    msg.method === "session/requestPermission";
  if (!isToolInvocation || !msg.params || typeof msg.params !== "object") return;

  const p = msg.params as Record<string, unknown>;
  const toolName = (p.name ?? p.tool) as string | undefined;
  if (toolName === "ask_question") {
    patchFieldIfAskQuestion(p, "arguments");
    patchFieldIfAskQuestion(p, "rawInput");
  }
}

function clearPendingByRequestId(
  pendingQuestions: Map<string, PendingQuestionRequest>,
  id: string | number,
): void {
  for (const [sessionId, pending] of pendingQuestions.entries()) {
    if (pending.requestId === id) {
      pendingQuestions.delete(sessionId);
      break;
    }
  }
}

async function unblockPendingQuestion(
  pending: PendingQuestionRequest,
  sessionId: string,
  context: OutboundContext,
): Promise<void> {
  await context.writeToChild?.({
    jsonrpc: "2.0",
    id: pending.requestId,
    result: { outcome: { outcome: "cancelled" } },
  });

  if (!pending.toolCallId) return;

  context.forwardInbound?.({
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
        toolCallId: pending.toolCallId,
        status: "completed",
      },
    },
  });
}

function isPermissionMethod(method: string | undefined): boolean {
  return (
    method === ACP_METHODS.SESSION_REQUEST_PERMISSION || method === "session/requestPermission"
  );
}

interface PermissionDetails {
  sessionId?: string;
  toolCallId?: string;
}

function extractToolCallId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const toolCall = (params as Record<string, unknown>).toolCall;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const id = (toolCall as Record<string, unknown>).toolCallId;
  return typeof id === "string" ? id : undefined;
}

function extractPermissionDetails(msg: AcpStreamMessage): PermissionDetails {
  const sessionId = extractSessionId(msg);
  const toolCallId = "params" in msg ? extractToolCallId(msg.params) : undefined;

  const details: PermissionDetails = {};
  if (sessionId) details.sessionId = sessionId;
  if (toolCallId) details.toolCallId = toolCallId;
  return details;
}

function recordInboundPermission(
  msg: AcpStreamMessage,
  pendingQuestions: Map<string, PendingQuestionRequest>,
): void {
  const method = "method" in msg ? String(msg.method) : undefined;
  if (!isPermissionMethod(method) || !("id" in msg)) return;

  const id = (msg as { id?: string | number | null }).id;
  if (id === undefined || id === null) return;

  const { sessionId, toolCallId } = extractPermissionDetails(msg);
  if (sessionId) {
    const pending: PendingQuestionRequest = { requestId: id, sessionId };
    if (toolCallId) pending.toolCallId = toolCallId;
    pendingQuestions.set(sessionId, pending);
  }
}

function trackInboundToolCallId(
  msg: AcpStreamMessage,
  pendingQuestions: Map<string, PendingQuestionRequest>,
): void {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return;

  const update = (msg.params as SessionUpdateParams | undefined)?.update;
  if (!update) return;

  handleSessionUpdate(update);
  const sessionId = extractSessionId(msg);
  if (!sessionId || update.sessionUpdate !== SESSION_UPDATES.TOOL_CALL) return;

  if (isAskQuestionName(update.name, update.title) && update.toolCallId) {
    const existing = pendingQuestions.get(sessionId);
    if (existing && !existing.toolCallId) {
      existing.toolCallId = update.toolCallId;
    }
  }
}

export function createQuestionOptionsFix(): AcpFix {
  const pendingQuestions = new Map<string, PendingQuestionRequest>();

  return {
    name: "missing-question-fallback",
    description:
      "Unblocks interactive questions when user sends a chat message and provides question fallback handling",

    onOutbound: async (
      msg: AcpStreamMessage,
      context: OutboundContext,
    ): Promise<AcpStreamMessage> => {
      if ("id" in msg && msg.id !== undefined && msg.id !== null) {
        clearPendingByRequestId(pendingQuestions, msg.id);
      }

      const isPromptOrCancel =
        isMethod(msg, ACP_METHODS.SESSION_PROMPT) || isMethod(msg, ACP_METHODS.SESSION_CANCEL);

      if (isPromptOrCancel) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          const pending = pendingQuestions.get(sessionId);
          if (pending) {
            pendingQuestions.delete(sessionId);
            await unblockPendingQuestion(pending, sessionId, context);
          }
        }
      }

      return msg;
    },

    onInbound: (msg: AcpStreamMessage, _context: InboundContext): AcpStreamMessage[] => {
      recordInboundPermission(msg, pendingQuestions);

      if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
        trackInboundToolCallId(msg, pendingQuestions);
      } else {
        handleRpcRequest(msg);
      }

      if ("result" in msg || "error" in msg) {
        const id = (msg as { id?: string | number }).id;
        if (id !== undefined && id !== null) {
          clearPendingByRequestId(pendingQuestions, id);
        }
      }

      return [msg];
    },

    dispose: (): void => {
      pendingQuestions.clear();
    },
  };
}

export const missingQuestionFallbackFix: AcpFix = createQuestionOptionsFix();
export const questionOptionsFix = missingQuestionFallbackFix;
