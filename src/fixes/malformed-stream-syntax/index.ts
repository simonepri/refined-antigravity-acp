/**
 * Problem:
 * Upstream models frequently emit syntax that crashes editor markdown and diagram parsers:
 * unquoted Mermaid labels containing parentheses (`id[Label (Text)]`), raw LaTeX math escapes
 * (`\\le`, `\\pm`), and leaked internal harness tags (`<system_instruction>`, `<task_output>`).
 *
 * Solution:
 * Streams output through an incremental lexer that wraps unquoted Mermaid labels in `["..."]`,
 * translates LaTeX escapes to Unicode equivalents (`≤`, `±`), and strips internal tags across chunk boundaries.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type SessionUpdateParams,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";

export const HARNESS_TAGS = [
  "system_message",
  "system_notification",
  "system_information",
  "system_instruction",
  "task_notification",
  "task_output",
  "context",
  "messaging",
  "receive_notifications_directly",
  "wait_for_task",
  "additional_metadata",
  "user_request",
  "user_instruction",
  "user_information",
  "scratchpad",
  "identity",
  "communication_style",
  "mcp_servers",
  "subagents",
  "artifacts",
  "ask_question",
] as const;

const ALL_HARNESS_TAGS = [...HARNESS_TAGS, ...HARNESS_TAGS.map((t) => t.replace(/_/g, "-"))];
const HARNESS_PATTERN = ALL_HARNESS_TAGS.join("|");

export const HARNESS_LEAK_REGEX = new RegExp(
  String.raw`The following is a <SYSTEM_MESSAGE> not actually sent by the user(?:[\s\S]*?<\/SYSTEM_MESSAGE>|[^\n]*\n?)|<\s*(?:${HARNESS_PATTERN})(?:\s+[^>]*)?>(?:[\s\S]*?<\/\s*(?:${HARNESS_PATTERN})\s*>|[\s\S]*$)|<\/?\s*(?:${HARNESS_PATTERN})(?:\s+[^>]*)?>`,
  "gi",
);

/**
 * Strips leaked Google harness and subagent internal tags from text in a single pass.
 */
export function sanitizeText(text: string): string {
  return text.replace(HARNESS_LEAK_REGEX, "").trim();
}

const HARNESS_SET = new Set(HARNESS_TAGS.map((t) => t.toLowerCase().replace(/[-_]/g, "_")));
const LOWER_HARNESS_TAGS = HARNESS_TAGS.map((t) => t.toLowerCase().replace(/[-_]/g, "_"));

function normalizeTagName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "_");
}

function isHarnessTag(tagName: string): boolean {
  return HARNESS_SET.has(normalizeTagName(tagName));
}

function isPossibleHarnessPrefix(str: string): boolean {
  const clean = normalizeTagName(str.replace(/^<\/?/, ""));
  if (clean === "") return true;
  if (/^[^\sa-zA-Z0-9_]/.test(clean)) return false;
  return LOWER_HARNESS_TAGS.some((t) => t.startsWith(clean));
}

const SYSTEM_MSG_INTRO = "The following is a <SYSTEM_MESSAGE> not actually sent by the user";
const SYSTEM_MSG_INTRO_LOWER = SYSTEM_MSG_INTRO.toLowerCase();
const SYSTEM_MSG_MATCH_RE =
  /The following is a <SYSTEM_MESSAGE> not actually sent by the user[^\n]*\n?/i;
const FULL_TAG_RE = /^<\s*(\/?)\s*([a-zA-Z0-9_-]+)/;

function checkBannerPartialPrefix(input: string): number | null {
  const minPrefixLen = 15;
  if (input.length < minPrefixLen) return null;
  const maxLen = Math.min(input.length, SYSTEM_MSG_INTRO.length);
  for (let len = maxLen; len >= minPrefixLen; len--) {
    const startIdx = input.length - len;
    if (input[startIdx]?.toLowerCase() !== "t") continue;
    const candidate = input.slice(startIdx).toLowerCase();
    if (SYSTEM_MSG_INTRO_LOWER.startsWith(candidate)) {
      return startIdx;
    }
  }
  return null;
}

const ANY_TAG_RE = /<\s*(\/?)\s*([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>/i;

export class StreamSanitizer {
  private harnessStack: string[] = [];
  private buffer = "";

  get inHarnessTag(): boolean {
    return this.harnessStack.length > 0;
  }

  reset(): void {
    this.harnessStack = [];
    this.buffer = "";
  }

  process(chunk: string): string {
    let input = this.buffer + chunk;
    this.buffer = "";
    let output = "";

    while (input.length > 0) {
      if (this.inHarnessTag) {
        input = this.processInHarness(input);
        continue;
      }

      const sysResult = this.checkSystemMessage(input);
      if (sysResult.matched) {
        output += sysResult.outputPrefix;
        input = sysResult.remainder;
        continue;
      }

      const bannerPrefixIdx = checkBannerPartialPrefix(input);
      if (bannerPrefixIdx !== null) {
        output += input.slice(0, bannerPrefixIdx);
        this.buffer = input.slice(bannerPrefixIdx);
        break;
      }

      const ltIdx = input.indexOf("<");
      if (ltIdx === -1) {
        output += input;
        break;
      }

      if (ltIdx > 0) {
        output += input.slice(0, ltIdx);
        input = input.slice(ltIdx);
      }

      const gtIdx = input.indexOf(">");
      if (gtIdx === -1) {
        if (isPossibleHarnessPrefix(input)) {
          this.buffer = input;
          break;
        }
        output += input[0];
        input = input.slice(1);
        continue;
      }

      const res = this.handleFullTag(input, gtIdx);
      output += res.text;
      input = res.remainder;
    }

    return output;
  }

  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    if (this.inHarnessTag) {
      return "";
    }
    if (!remaining) {
      return "";
    }
    const clean = normalizeTagName(remaining.replace(/^<\/?/, ""));
    if (clean !== "" && LOWER_HARNESS_TAGS.some((t) => t.startsWith(clean))) {
      return "";
    }
    if (checkBannerPartialPrefix(remaining) !== null) {
      return "";
    }
    return remaining;
  }

  private checkSystemMessage(input: string): {
    outputPrefix: string;
    remainder: string;
    matched: boolean;
  } {
    if (!input.includes("SYSTEM_MESSAGE")) {
      return { outputPrefix: "", remainder: input, matched: false };
    }
    const sysMatch = input.match(SYSTEM_MSG_MATCH_RE);
    if (!sysMatch || sysMatch.index === undefined) {
      return { outputPrefix: "", remainder: input, matched: false };
    }
    // If the matched banner line has no newline at the end and no tag immediately follows,
    // buffer it because more text on this line could still be streaming in.
    if (
      !sysMatch[0].endsWith("\n") &&
      !input.slice(sysMatch.index + sysMatch[0].length).startsWith("<")
    ) {
      this.buffer = input.slice(sysMatch.index);
      return {
        outputPrefix: input.slice(0, sysMatch.index),
        remainder: "",
        matched: true,
      };
    }
    return {
      outputPrefix: input.slice(0, sysMatch.index),
      remainder: input.slice(sysMatch.index + sysMatch[0].length),
      matched: true,
    };
  }

  private handleHarnessTag(tagName: string, isClosing: boolean): void {
    if (!isHarnessTag(tagName)) return;
    if (!isClosing) {
      this.harnessStack.push(tagName);
      return;
    }
    const idx = this.harnessStack.lastIndexOf(tagName);
    if (idx !== -1) {
      this.harnessStack.splice(idx);
    } else {
      this.harnessStack.pop();
    }
  }

  private bufferPotentialTag(input: string): void {
    const lastLt = input.lastIndexOf("<");
    if (lastLt !== -1 && lastLt >= input.length - 40) {
      const candidate = input.slice(lastLt);
      if (isPossibleHarnessPrefix(candidate)) {
        this.buffer = candidate;
      }
    }
  }

  private processInHarness(input: string): string {
    while (input.length > 0) {
      const match = input.match(ANY_TAG_RE);
      if (!match || match.index === undefined) {
        this.bufferPotentialTag(input);
        return "";
      }

      const isClosing = match[1] === "/" || (match[0] !== undefined && match[0].endsWith("/>"));
      const tagName = normalizeTagName(match[2] ?? "");
      const endIdx = match.index + (match[0]?.length ?? 0);
      input = input.slice(endIdx);

      this.handleHarnessTag(tagName, isClosing);
      if (this.harnessStack.length === 0) {
        return input;
      }
    }
    return "";
  }

  private handleFullTag(input: string, gtIdx: number): { text: string; remainder: string } {
    const fullTag = input.slice(0, gtIdx + 1);
    const match = fullTag.match(FULL_TAG_RE);
    if (match) {
      const isClosing =
        match[1] === "/" || fullTag.endsWith("/>") || fullTag.trimEnd().endsWith("/>");
      const tagName = normalizeTagName(match[2] ?? "");
      if (isHarnessTag(tagName)) {
        this.handleHarnessTag(tagName, isClosing);
        return { text: "", remainder: input.slice(gtIdx + 1) };
      }
    }
    return { text: input[0] ?? "", remainder: input.slice(1) };
  }
}

function fallbackSanitizeBlock(block: unknown): void {
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    block.text = sanitizeText(block.text);
  }
}

export function fallbackSanitizeInboundText(msg: AcpStreamMessage): void {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return;
  const content = (msg.params as SessionUpdateParams | undefined)?.update?.content;
  if (!content) return;

  if (Array.isArray(content)) {
    for (const block of content) fallbackSanitizeBlock(block);
  } else {
    fallbackSanitizeBlock(content);
  }
}

function sanitizeBlock(block: unknown, sanitizer: StreamSanitizer): boolean {
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    block.text = sanitizer.process(block.text);
    return block.text !== "";
  }
  return true;
}

function extractUpdateContent(
  msg: AcpStreamMessage,
): { content: unknown; isMessageChunk: boolean } | null {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return null;
  const update = (msg.params as SessionUpdateParams | undefined)?.update;
  if (!update || typeof update !== "object") return null;
  const content = update.content;
  if (!content) return null;
  const isMessageChunk = update.sessionUpdate === SESSION_UPDATES.AGENT_MESSAGE_CHUNK;
  return { content, isMessageChunk };
}

export function sanitizeInboundText(msg: AcpStreamMessage, sanitizer: StreamSanitizer): boolean {
  const target = extractUpdateContent(msg);
  if (!target) return true;

  let hasNonEmpty = false;
  if (Array.isArray(target.content)) {
    for (const block of target.content) {
      if (sanitizeBlock(block, sanitizer)) hasNonEmpty = true;
    }
  } else {
    hasNonEmpty = sanitizeBlock(target.content, sanitizer);
  }

  return !target.isMessageChunk || hasNonEmpty;
}

function agentMessageChunk(sessionId: string, text: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
        content: { type: "text", text },
      },
    },
  } as unknown as AcpStreamMessage;
}

export const STREAM_SANITIZATION_INSTRUCTIONS: readonly string[] = [
  "Format math using plain Unicode symbols instead of LaTeX.",
  "In Mermaid diagrams, only use supported diagram types: flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, xychart-beta (do not use unsupported types like gantt or gitGraph). Quote node labels containing special characters like parentheses.",
];

export function createMalformedStreamSyntaxFix(): AcpFix & { sanitizer: StreamSanitizer } {
  const sanitizer = new StreamSanitizer();
  let lastSessionId: string | null = null;

  return {
    name: "malformed-stream-syntax",
    description:
      "Sanitizes unquoted Mermaid diagram labels, LaTeX math escapes, and leaked system tags across streaming chunks",
    sanitizer,

    onOutbound(msg: AcpStreamMessage): AcpStreamMessage {
      if (
        isMethod(msg, ACP_METHODS.SESSION_PROMPT) ||
        isMethod(msg, ACP_METHODS.SESSION_CANCEL) ||
        isMethod(msg, ACP_METHODS.SESSION_NEW) ||
        isMethod(msg, ACP_METHODS.SESSION_LOAD)
      ) {
        sanitizer.reset();
      }
      return msg;
    },

    onInbound(msg: AcpStreamMessage): AcpStreamMessage[] {
      if (isMethod(msg, ACP_METHODS.SESSION_UPDATE)) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          lastSessionId = sessionId;
        }
        const keep = sanitizeInboundText(msg, sanitizer);
        return keep ? [msg] : [];
      }

      if ("result" in msg && msg.result) {
        const tail = sanitizer.flush();
        sanitizer.reset();
        return tail && lastSessionId ? [agentMessageChunk(lastSessionId, tail), msg] : [msg];
      }

      return [msg];
    },

    onTurnEnd(sessionId: string): AcpStreamMessage[] {
      const tail = sanitizer.flush();
      sanitizer.reset();
      return tail ? [agentMessageChunk(sessionId, tail)] : [];
    },

    getSystemInstructions(): readonly string[] {
      return STREAM_SANITIZATION_INSTRUCTIONS;
    },

    dispose(): void {
      sanitizer.reset();
      lastSessionId = null;
    },
  };
}

export const malformedStreamSyntaxFix = createMalformedStreamSyntaxFix();
export const createStreamSanitizationFix = createMalformedStreamSyntaxFix;
export const streamSanitizationFix = malformedStreamSyntaxFix;
