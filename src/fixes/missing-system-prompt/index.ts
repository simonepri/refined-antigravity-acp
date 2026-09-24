/**
 * Problem:
 * Standard ACP protocol clients configure custom system prompts, workspace instructions,
 * and personas via `_meta.systemPrompt` (or client-nested metadata). Upstream `agy_acp_server`
 * ignores these metadata fields, providing no native mechanism to inject custom personas or rules.
 *
 * Solution:
 * Caches client system prompts and dynamically injects them into the initial prompt turn
 * enclosed in `<system_instruction>` and `<user_instruction>` blocks without mutating persisted history.
 */

import {
  ACP_METHODS,
  isMethod,
  type AcpStreamMessage,
  type AcpFix,
  type OutboundContext,
  type SessionPromptParams,
} from "../../core/types.js";
import {
  extractSessionId,
  getOrCreateSession,
  recordPendingSessionMetadata,
} from "../../core/session-cache.js";

export const INSTRUCTION_BLOCKS_PREFIX_PATTERN =
  /^\s*(?:<\s*(?:system|user)[-_](?:instruction|message)(?:\s+[^>]*)?>[\s\S]*?<\/\s*(?:system|user)[-_](?:instruction|message)\s*>\s*|<\s*skills(?:\s+[^>]*)?>[\s\S]*?<\/\s*skills\s*>\s*)+/i;

export function stripSystemContext(text: string): string {
  return text.replace(INSTRUCTION_BLOCKS_PREFIX_PATTERN, "");
}

export function formatSystemContext(
  systemPrompt?: string,
  harnessInstructions: readonly string[] = [],
): string {
  const blocks: string[] = [];

  if (harnessInstructions.length > 0) {
    const formatted = harnessInstructions.map((r) => `- ${r}`).join("\n");
    blocks.push(`<system_instruction>\n${formatted}\n</system_instruction>`);
  }

  if (systemPrompt && systemPrompt.trim().length > 0) {
    blocks.push(`<user_instruction>\n${systemPrompt.trim()}\n</user_instruction>`);
  }

  return blocks.join("\n\n");
}

interface PromptChunk {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface OutboundParams {
  sessionId?: string;
  prompt?: PromptChunk[];
  _meta?: {
    systemPrompt?: string;
    [key: string]: unknown;
  };
  cwd?: string;
}

function findNestedSystemPrompt(meta: Record<string, unknown>): string | undefined {
  for (const val of Object.values(meta)) {
    if (val && typeof val === "object" && "systemPrompt" in val) {
      const nested = (val as { systemPrompt?: unknown }).systemPrompt;
      if (typeof nested === "string" && nested.trim().length > 0) {
        return nested.trim();
      }
    }
  }
  return undefined;
}

export function extractSystemPrompt(msg: AcpStreamMessage): string | undefined {
  if (!("params" in msg) || !msg.params) return undefined;
  const params = msg.params as OutboundParams;
  if (!params._meta) return undefined;

  if (typeof params._meta.systemPrompt === "string") {
    const trimmed = params._meta.systemPrompt.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return findNestedSystemPrompt(params._meta);
}

export function injectSystemContext(
  prompt: unknown,
  systemPrompt?: string,
  harnessInstructions: readonly string[] = [],
): void {
  if (!Array.isArray(prompt)) return;
  const context = formatSystemContext(systemPrompt, harnessInstructions);
  if (!context) return;

  const firstChunk = prompt[0] as PromptChunk | undefined;
  if (firstChunk && firstChunk.type === "text" && typeof firstChunk.text === "string") {
    firstChunk.text = `${context}\n\n${firstChunk.text}`;
  } else {
    prompt.unshift({
      type: "text",
      text: context,
    });
  }
}

function handleSessionNewOutbound(msg: AcpStreamMessage, context: OutboundContext): void {
  const systemPrompt = extractSystemPrompt(msg);
  if (!systemPrompt || !("id" in msg) || msg.id === null || msg.id === undefined) return;
  const pending = context.sessionCache.pendingSessionMetadata.get(msg.id) ?? {};
  pending.fixData ??= new Map();
  pending.fixData.set("systemPrompt", systemPrompt);
  recordPendingSessionMetadata(context.sessionCache, msg.id, pending);
}

function collectSystemInstructions(
  fixes: readonly AcpFix[] | undefined,
  session: Parameters<typeof getOrCreateSession>[1] extends string
    ? ReturnType<typeof getOrCreateSession>
    : never,
  context: OutboundContext,
): string[] {
  if (!fixes) return [];
  const instructions: string[] = [];
  for (const fix of fixes) {
    const list = fix.getSystemInstructions?.(session, context);
    if (list && list.length > 0) {
      instructions.push(...list);
    }
  }
  return instructions;
}

function handleSessionPromptOutbound(msg: AcpStreamMessage, context: OutboundContext): void {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return;

  const session = getOrCreateSession(context.sessionCache, sessionId);
  if (session.fixData?.get("hasInjectedSystemContext")) return;

  const systemPrompt = session.fixData?.get("systemPrompt") as string | undefined;
  const prompt =
    "params" in msg ? (msg.params as SessionPromptParams | undefined)?.prompt : undefined;
  const instructions = collectSystemInstructions(context.fixes, session, context);

  injectSystemContext(prompt, systemPrompt, instructions);
  session.fixData ??= new Map();
  session.fixData.set("hasInjectedSystemContext", true);
}

export const missingSystemPromptFix: AcpFix = {
  name: "missing-system-prompt",
  description:
    "Injects client-configured custom system prompts and instructions into session prompts",

  onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
    if (isMethod(msg, ACP_METHODS.SESSION_NEW)) {
      handleSessionNewOutbound(msg, context);
    } else if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
      handleSessionPromptOutbound(msg, context);
    }
    return msg;
  },
};

export const systemPromptFix = missingSystemPromptFix;
