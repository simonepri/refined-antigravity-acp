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
  "user_information",
  "scratchpad",
  "identity",
  "communication_style",
  "mcp_servers",
  "subagents",
  "artifacts",
  "ask_question",
] as const;

const HARNESS_SET = new Set(HARNESS_TAGS.map((t) => t.toLowerCase()));

/**
 * Marker prepended to the replacement prompt Paseo dispatches when the user steers
 * a running turn. It tells the model the new text interrupts and supersedes the
 * instruction it was working on. It is stripped again on every read path:
 * assistant output (`sanitizeAssistantText`, `cleanStreamingChunk`) and SQLite
 * history replay (`server/history.ts`), so it never reaches the Paseo timeline.
 */
export const STEERING_PREFIX = "[Mid-turn update]: ";

const STEERING_PREFIX_PATTERN = /(?:^|\n)\s*\[Mid-turn update\]:\s*/gi;

/** Removes any echoed steering marker from text that is about to be displayed. */
export function stripSteeringPrefix(text: string): string {
  return text.replace(STEERING_PREFIX_PATTERN, "");
}

function isHarnessTag(tagName: string): boolean {
  return HARNESS_SET.has(tagName.toLowerCase());
}

function isPossibleHarnessPrefix(str: string): boolean {
  const clean = str.replace(/^<\/?/, "").toLowerCase();
  if (clean === "") return true;
  if (/^[^\sa-zA-Z0-9_-]/.test(clean)) return false;
  return HARNESS_TAGS.some((t) => t.toLowerCase().startsWith(clean));
}

const SYSTEM_MSG_INTRO = "The following is a <SYSTEM_MESSAGE> not actually sent by the user";

function checkBannerPartialPrefix(input: string): number | null {
  const minPrefixLen = 15;
  for (let len = Math.min(input.length, SYSTEM_MSG_INTRO.length); len >= minPrefixLen; len--) {
    const candidate = input.slice(input.length - len);
    if (SYSTEM_MSG_INTRO.toLowerCase().startsWith(candidate.toLowerCase())) {
      return input.length - len;
    }
  }
  return null;
}

function cleanStreamingChunk(text: string): string {
  return text
    .replace(
      /(?:\b(?:The\s+request\s+was\s+cancell?ed\s+by\s+the\s+client|context\s+cancell?ed)\b\.?)/gi,
      "",
    )
    .replace(STEERING_PREFIX_PATTERN, "")
    .replace(/\$\s*\\(?:to|rightarrow)\s*\$/gi, "→")
    .replace(/\$\s*\\leftarrow\s*\$/gi, "←")
    .replace(/\$\s*\\(?:implies|Rightarrow)\s*\$/gi, "⇒")
    .replace(/\$\s*\\leftrightarrow\s*\$/gi, "↔")
    .replace(/\$\s*\\le(?:q)?\s*\$/gi, "≤")
    .replace(/\$\s*\\ge(?:q)?\s*\$/gi, "≥")
    .replace(/\$\s*\\ne(?:q)?\s*\$/gi, "≠")
    .replace(/\$\s*\\approx\s*\$/gi, "≈")
    .replace(/\$\s*\\times\s*\$/gi, "×")
    .replace(/\$\s*\\pm\s*\$/gi, "±")
    .replace(/\$\s*\\infty\s*\$/gi, "∞")
    .replace(/\\(?:to|rightarrow)\b/gi, "→")
    .replace(/\\leftarrow\b/gi, "←")
    .replace(/<kbd>(.*?)<\/kbd>/gi, "`$1`")
    .replace(/<u>(.*?)<\/u>/gi, "*$1*")
    .replace(/<mark>(.*?)<\/mark>/gi, "**$1**")
    .replace(/<sup>(.*?)<\/sup>/gi, "^($1)");
}

export class StreamSanitizer {
  private inHarnessTag = false;
  private buffer = "";

  reset(): void {
    this.inHarnessTag = false;
    this.buffer = "";
  }

  private processInHarness(input: string): string {
    const closeMatch = input.match(/<\/\s*([a-zA-Z0-9_-]+)\s*>/i);
    if (closeMatch && closeMatch.index !== undefined) {
      const tagName = closeMatch[1].toLowerCase();
      const endIdx = closeMatch.index + closeMatch[0].length;
      if (isHarnessTag(tagName)) {
        this.inHarnessTag = false;
      }
      return input.slice(endIdx);
    }

    const lastLt = input.lastIndexOf("<");
    if (lastLt !== -1 && lastLt >= input.length - 40) {
      const candidate = input.slice(lastLt);
      if (isPossibleHarnessPrefix(candidate)) {
        this.buffer = candidate;
        return "";
      }
    }
    return "";
  }

  private handleFullTag(input: string, gtIdx: number): { text: string; remainder: string } {
    const fullTag = input.slice(0, gtIdx + 1);
    const match = fullTag.match(/^<\s*(\/?)\s*([a-zA-Z0-9_-]+)/);
    if (match) {
      const isClosing = match[1] === "/";
      const tagName = match[2].toLowerCase();
      if (isHarnessTag(tagName)) {
        if (!isClosing) this.inHarnessTag = true;
        return { text: "", remainder: input.slice(gtIdx + 1) };
      }
    }
    return { text: input[0], remainder: input.slice(1) };
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

      const sysMatch = input.match(
        /The following is a <SYSTEM_MESSAGE> not actually sent by the user[^\n]*\n?/i,
      );
      if (sysMatch && sysMatch.index !== undefined) {
        output += input.slice(0, sysMatch.index);
        input = input.slice(sysMatch.index + sysMatch[0].length);
        this.inHarnessTag = true;
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

    return cleanStreamingChunk(output);
  }

  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    if (this.inHarnessTag) return "";
    return cleanStreamingChunk(remaining);
  }
}

export function sanitizeAssistantText(text: string): string {
  const harnessPattern = HARNESS_TAGS.join("|");
  return (
    text
      // Strip leaked internal harness tags & system notifications (both paired and streaming/unclosed)
      .replace(
        /The following is a <SYSTEM_MESSAGE> not actually sent by the user[\s\S]*?<\/SYSTEM_MESSAGE>/gi,
        "",
      )
      .replace(
        new RegExp(
          `<(?:${harnessPattern})>(?:[\\s\\S]*?<\\/(?:${harnessPattern})>|[\\s\\S]*$)`,
          "gi",
        ),
        "",
      )
      // Strip stray unclosed/opened harness tags if any remain
      .replace(new RegExp(`<\\/?(?:${harnessPattern})>`, "gi"), "")
      // Strip client cancellation error messages emitted during turn abort / steering
      .replace(
        /(?:\b(?:The\s+request\s+was\s+cancell?ed\s+by\s+the\s+client|context\s+cancell?ed)\b\.?)/gi,
        "",
      )
      // Strip any echoed mid-turn update prefixes
      .replace(STEERING_PREFIX_PATTERN, "")
      // Convert common LaTeX math escapes to Unicode (Paseo does not render KaTeX/LaTeX)
      .replace(/\$\s*\\(?:to|rightarrow)\s*\$/gi, "→")
      .replace(/\$\s*\\leftarrow\s*\$/gi, "←")
      .replace(/\$\s*\\(?:implies|Rightarrow)\s*\$/gi, "⇒")
      .replace(/\$\s*\\leftrightarrow\s*\$/gi, "↔")
      .replace(/\$\s*\\le(?:q)?\s*\$/gi, "≤")
      .replace(/\$\s*\\ge(?:q)?\s*\$/gi, "≥")
      .replace(/\$\s*\\ne(?:q)?\s*\$/gi, "≠")
      .replace(/\$\s*\\approx\s*\$/gi, "≈")
      .replace(/\$\s*\\times\s*\$/gi, "×")
      .replace(/\$\s*\\pm\s*\$/gi, "±")
      .replace(/\$\s*\\infty\s*\$/gi, "∞")
      .replace(/\\(?:to|rightarrow)\b/gi, "→")
      .replace(/\\leftarrow\b/gi, "←")
      // Normalize keyboard keys for Paseo
      .replace(/<kbd>(.*?)<\/kbd>/gi, "`$1`")
      // Normalize basic styling tags that Paseo markdown parser does not wrap
      .replace(/<u>(.*?)<\/u>/gi, "*$1*")
      .replace(/<mark>(.*?)<\/mark>/gi, "**$1**")
      .replace(/<sup>(.*?)<\/sup>/gi, "^($1)")
      .trim()
  );
}

export function formatSystemContext(systemPrompt?: string): string {
  const parts: string[] = [];

  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push(`[System Context]:\n${systemPrompt.trim()}`);
  }

  parts.push(
    `[Formatting Guidance]:
- Math: The UI does not render LaTeX ($...$, $$...$$, \\to, \\frac). Use plain text or Unicode formulas (e.g. x^2, a/b, →, √, ∑).
- Mermaid: Always wrap both node labels AND edge labels containing spaces, punctuation, slashes, or parentheses in double quotes (e.g. id["Label (Details)"] and -->|"Label (Details)"|). Never put unquoted parentheses inside edge pipes |...| or node shapes.
- Keys & Markup: Use markdown backticks (\`Cmd\`, \`Ctrl+C\`) instead of HTML <kbd> tags. Never output internal tags like <system_message>.`,
  );

  return parts.join("\n\n");
}

/**
 * Formats the replacement prompt for a steered turn, marking it as a mid-turn
 * interruption so the model treats it as superseding the instruction in flight.
 */
const SYSTEM_CONTEXT_PATTERN =
  /(?:\[System Context\]:[\s\S]*?)?\[Formatting Guidance\]:[\s\S]*?(?=\n\n|$)\n*/g;

/**
 * Removes injected system context and formatting guidance from replayed user text so it
 * does not clutter the Paseo timeline.
 */
export function stripSystemContext(text: string): string {
  return text.replace(SYSTEM_CONTEXT_PATTERN, "");
}

export function formatSteeringPrompt(userText: string): string {
  return `${STEERING_PREFIX}${userText.trim()}`;
}
