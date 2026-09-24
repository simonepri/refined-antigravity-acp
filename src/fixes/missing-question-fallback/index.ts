/**
 * Problem:
 * Upstream system prompts explicitly forbid the model from providing an "Other" option in
 * multiple-choice user prompts (`"Do NOT add an 'Other' option to questions"`), stranding users
 * with no way to enter custom or free-text answers when none of the choices apply.
 *
 * Solution:
 * Injects a prompt override directing the model to always provide an "Other" option for free-text
 * answers, and intercepts inbound `ask_question` tool calls to append a fallback "Other" choice if omitted.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";

export const QUESTION_OPTIONS_INSTRUCTIONS: readonly string[] = [
  "Ignore the ask_question 'no other' rule: always include an 'Other' option for free-text responses.",
];

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

function isAskQuestionName(name?: string, title?: string): boolean {
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
    msg.method === "tools/call" || msg.method === "session/requestPermission";
  if (!isToolInvocation || !msg.params || typeof msg.params !== "object") return;

  const p = msg.params as Record<string, unknown>;
  const toolName = (p.name ?? p.tool) as string | undefined;
  if (toolName === "ask_question") {
    patchFieldIfAskQuestion(p, "arguments");
    patchFieldIfAskQuestion(p, "rawInput");
  }
}

function processInboundToolCall(msg: AcpStreamMessage): AcpStreamMessage {
  if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
    const update = (msg.params as SessionUpdateParams | undefined)?.update;
    if (update) handleSessionUpdate(update);
  } else {
    handleRpcRequest(msg);
  }

  return msg;
}

export const missingQuestionFallbackFix: AcpFix = {
  name: "missing-question-fallback",
  description:
    "Steers model to include an Other choice and injects a fallback option into ask_question tool calls",

  getSystemInstructions(): readonly string[] {
    return QUESTION_OPTIONS_INSTRUCTIONS;
  },

  onInbound(msg: AcpStreamMessage): AcpStreamMessage[] {
    return [processInboundToolCall(msg)];
  },
};

export const questionOptionsFix = missingQuestionFallbackFix;
