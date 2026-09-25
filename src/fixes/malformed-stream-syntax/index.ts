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
 * Strips leaked Google harness and subagent internal tags from text using StreamSanitizer.
 */
export function sanitizeText(text: string): string {
  const sanitizer = new StreamSanitizer();
  return (sanitizer.process(text) + sanitizer.flush()).trim();
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
  /The following is a <SYSTEM_MESSAGE> not actually sent by the user[^\n]*\n*/i;
const FULL_TAG_RE = /^<\s*(\/?)\s*([a-zA-Z0-9_-]+)/;

const BG_TASK_INTRO = "Got a message from a background task:";
const BG_TASK_INTRO_LOWER = BG_TASK_INTRO.toLowerCase();
const BG_SUBAGENT_INTRO = "Got a message from a subagent:";
const BG_SUBAGENT_INTRO_LOWER = BG_SUBAGENT_INTRO.toLowerCase();
const BG_TASK_RESUME_INTRO = "... Resuming execution after task execution ...";
const BG_TASK_RESUME_INTRO_LOWER = BG_TASK_RESUME_INTRO.toLowerCase();
const BG_SUBAGENT_RESUME_INTRO = "... Resuming execution after subagent execution ...";
const BG_SUBAGENT_RESUME_INTRO_LOWER = BG_SUBAGENT_RESUME_INTRO.toLowerCase();
const BG_TASK_RESUME_ELLIPSIS_INTRO = "… Resuming execution after task execution …";
const BG_TASK_RESUME_ELLIPSIS_INTRO_LOWER = BG_TASK_RESUME_ELLIPSIS_INTRO.toLowerCase();
const BG_SUBAGENT_RESUME_ELLIPSIS_INTRO = "… Resuming execution after subagent execution …";
const BG_SUBAGENT_RESUME_ELLIPSIS_INTRO_LOWER = BG_SUBAGENT_RESUME_ELLIPSIS_INTRO.toLowerCase();
const BG_TASK_FINISHED_INTRO = "Background task '";
const BG_TASK_FINISHED_INTRO_LOWER = BG_TASK_FINISHED_INTRO.toLowerCase();
const BG_SUBAGENT_FINISHED_INTRO = "Subagent '";
const BG_SUBAGENT_FINISHED_INTRO_LOWER = BG_SUBAGENT_FINISHED_INTRO.toLowerCase();

const BG_TASK_HEADER_RE =
  /(?:^|\n)[ \t]*(?:Got a message from a (?:background task|subagent):\s*\n[ \t]*\[(?:[^\]]+\/)?(?:task|subagent)-[^\]]+\] Output:|(?:(?:\.\.\.|\u2026)\s*Resuming execution after (?:task|subagent) execution\s*(?:\.\.\.|\u2026)\s*\n[ \t]*)?(?:Background task|Subagent)\s*'[^']+'\s*has finished\.\s*\n[ \t]*Exit code:\s*\S+\s*\n[ \t]*(?:Task|Subagent) output:|(?:\.\.\.|\u2026)\s*Resuming execution after (?:task|subagent) execution\s*(?:\.\.\.|\u2026))\s*\n*/i;

const BG_TASK_FOOTER_RE =
  /(?:Task (?:task|subagent)-\S+ (?:completed|finished|failed|was canceled)[^\n]*\n*|Task id "[^"]+" (?:completed|finished|failed|was canceled)[^\n]*\n*)/i;

const BG_TASK_PARTIAL_HEADER_RE =
  /(?:^|\n)[ \t]*(?:Got a message from a (?:background task|subagent):\s*(?:\n[ \t]*\[[^\n]*)?|(?:\.\.\.|\u2026)\s*Resuming execution after (?:task|subagent) execution\s*(?:\.\.\.|\u2026)?(?:\n[ \t]*(?:Background task|Subagent)\s*(?:'[^'\n]*)?(?:'\s*has finished\.)?)?(?:\n[ \t]*Exit code:[^\n]*)?(?:\n[ \t]*(?:Task|Subagent) output:[^\n]*)?|(?:Background task|Subagent)\s*(?:'[^'\n]*)?(?:'\s*has finished\.)?(?:\n[ \t]*Exit code:[^\n]*)?(?:\n[ \t]*(?:Task|Subagent) output:[^\n]*)?)$/i;

function findLeadingWhitespaceStart(input: string, fromIdx: number): number {
  let startIdx = fromIdx;
  while (startIdx > 0 && /\s/.test(input[startIdx - 1] ?? "")) {
    startIdx--;
  }
  return startIdx;
}

function isLineStartCandidate(input: string, idx: number, char: string): boolean {
  if (input[idx]?.toLowerCase() !== char.toLowerCase()) return false;
  if (idx === 0) return true;
  let prev = idx - 1;
  while (prev >= 0 && (input[prev] === " " || input[prev] === "\t")) {
    prev--;
  }
  return prev < 0 || input[prev] === "\n" || input[prev] === "\r";
}

function isBannerCandidateStart(input: string, tIdx: number): boolean {
  return isLineStartCandidate(input, tIdx, "t");
}

function checkBannerPartialPrefix(input: string): number | null {
  for (let tIdx = 0; tIdx < input.length; tIdx++) {
    if (!isBannerCandidateStart(input, tIdx)) continue;

    const candidate = input.slice(tIdx).toLowerCase();
    if (SYSTEM_MSG_INTRO_LOWER.startsWith(candidate)) {
      return findLeadingWhitespaceStart(input, tIdx);
    }
  }
  return null;
}

const BG_TASK_INTROS_LOWER = [
  BG_TASK_INTRO_LOWER,
  BG_SUBAGENT_INTRO_LOWER,
  BG_TASK_RESUME_INTRO_LOWER,
  BG_SUBAGENT_RESUME_INTRO_LOWER,
  BG_TASK_RESUME_ELLIPSIS_INTRO_LOWER,
  BG_SUBAGENT_RESUME_ELLIPSIS_INTRO_LOWER,
  BG_TASK_FINISHED_INTRO_LOWER,
  BG_SUBAGENT_FINISHED_INTRO_LOWER,
] as const;

function isBgTaskCandidateStart(input: string, idx: number): boolean {
  const ch = input[idx];
  if (!ch) return false;
  const lower = ch.toLowerCase();
  if (lower === "g" || lower === "b" || lower === "s" || ch === "." || ch === "\u2026") {
    return isLineStartCandidate(input, idx, ch);
  }
  return false;
}

function checkBgTaskPartialPrefix(input: string): number | null {
  for (let idx = 0; idx < input.length; idx++) {
    if (!isBgTaskCandidateStart(input, idx)) continue;

    const candidate = input.slice(idx).toLowerCase();
    if (BG_TASK_INTROS_LOWER.some((intro) => intro.startsWith(candidate))) {
      return findLeadingWhitespaceStart(input, idx);
    }
  }
  return null;
}

function checkBgTaskPartialHeader(input: string): number | null {
  const match = input.match(BG_TASK_PARTIAL_HEADER_RE);
  if (match && match.index !== undefined) {
    return findLeadingWhitespaceStart(input, match.index);
  }
  return checkBgTaskPartialPrefix(input);
}

const ANY_TAG_RE = /<\s*(\/?)\s*([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>/i;

export class StreamSanitizer {
  private harnessStack: string[] = [];
  private buffer = "";
  private inBackgroundTask = false;

  get inHarnessTag(): boolean {
    return this.harnessStack.length > 0;
  }

  reset(): void {
    this.harnessStack = [];
    this.buffer = "";
    this.inBackgroundTask = false;
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

      if (this.inBackgroundTask) {
        input = this.processInBackgroundTask(input);
        continue;
      }

      const bannerCheck = this.checkBannerOrSystemMessage(input);
      if (bannerCheck.buffered) {
        output += bannerCheck.output;
        break;
      }
      if (bannerCheck.remainder !== input) {
        output += bannerCheck.output;
        input = bannerCheck.remainder;
        continue;
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
    if (this.inHarnessTag || this.inBackgroundTask || !remaining) {
      return "";
    }
    if (remaining.startsWith("<")) {
      const clean = normalizeTagName(remaining.replace(/^<\/?/, ""));
      if (clean !== "" && LOWER_HARNESS_TAGS.some((t) => t.startsWith(clean))) {
        return "";
      }
    }
    const lower = remaining.toLowerCase().trim();
    if (
      lower.startsWith(SYSTEM_MSG_INTRO_LOWER) ||
      BG_TASK_INTROS_LOWER.some((intro) => lower.startsWith(intro))
    ) {
      return "";
    }
    return remaining;
  }

  private processInBackgroundTask(input: string): string {
    const footerMatch = input.match(BG_TASK_FOOTER_RE);
    if (!footerMatch || footerMatch.index === undefined) {
      this.buffer = input.slice(-100);
      return "";
    }
    if (!footerMatch[0].endsWith("\n")) {
      this.buffer = input.slice(footerMatch.index);
      return "";
    }
    this.inBackgroundTask = false;
    this.buffer = "";
    return input.slice(footerMatch.index + footerMatch[0].length);
  }

  private checkBannerOrSystemMessage(input: string): {
    output: string;
    remainder: string;
    buffered: boolean;
  } {
    const bgHeader = input.match(BG_TASK_HEADER_RE);
    if (bgHeader && bgHeader.index !== undefined) {
      this.inBackgroundTask = true;
      return {
        output: input.slice(0, bgHeader.index),
        remainder: input.slice(bgHeader.index + bgHeader[0].length),
        buffered: false,
      };
    }

    const sysResult = this.checkSystemMessage(input);
    if (sysResult.matched) {
      return { output: sysResult.outputPrefix, remainder: sysResult.remainder, buffered: false };
    }

    const idx1 = checkBannerPartialPrefix(input);
    const idx2 = checkBgTaskPartialHeader(input);
    const bannerIdx = idx1 !== null && idx2 !== null ? Math.min(idx1, idx2) : (idx1 ?? idx2);
    if (bannerIdx !== null) {
      this.buffer = input.slice(bannerIdx);
      return { output: input.slice(0, bannerIdx), remainder: "", buffered: true };
    }

    return { output: "", remainder: input, buffered: false };
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
    const prefix = input.slice(0, sysMatch.index);
    const outputPrefix = prefix.trim() === "" ? "" : prefix;
    const matchEnd = sysMatch.index + sysMatch[0].length;
    if (!sysMatch[0].endsWith("\n") && !input.slice(matchEnd).startsWith("<")) {
      this.buffer = input.slice(sysMatch.index);
      return { outputPrefix, remainder: "", matched: true };
    }
    return {
      outputPrefix,
      remainder: input.slice(matchEnd),
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
