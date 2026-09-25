import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, SessionUpdateParams } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createStreamSanitizationFix, StreamSanitizer } from "./index.js";

describe("StreamSanitizer", () => {
  it("preserves valid assistant response text without modifications", () => {
    const sanitizer = new StreamSanitizer();
    expect(sanitizer.process("Hello world")).toBe("Hello world");
  });

  it("strips internal harness tags split across multiple streaming chunks", () => {
    const sanitizer = new StreamSanitizer();
    expect(sanitizer.process("<task_output>")).toBe("");
    expect(sanitizer.process("hidden output")).toBe("");
    expect(sanitizer.process("</task_output>Visible text")).toBe("Visible text");
  });

  it("strips nested harness tags without leaking internal content to the client", () => {
    const sanitizer = new StreamSanitizer();
    const res = sanitizer.process(
      "<task_output>secret1<context>secret2</context>secret3</task_output>Visible text",
    );
    expect(res).toBe("Visible text");
  });

  it("clears incomplete tag state across turn boundaries", () => {
    const sanitizer = new StreamSanitizer();
    sanitizer.process("<task_output>unfinished text");
    // Without reset, subsequent text would be swallowed
    sanitizer.reset();
    expect(sanitizer.process("Visible text after reset")).toBe("Visible text after reset");
  });

  it("does not swallow assistant message following synthetic system message block", () => {
    const sanitizer = new StreamSanitizer();
    const raw =
      "\n\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-24T18:40:02.164Z sender=task-637\nDone\n</SYSTEM_MESSAGE>Parity Prompt 33 is fully implemented.";
    const result = sanitizer.process(raw) + sanitizer.flush();
    expect(result.trim()).toBe("Parity Prompt 33 is fully implemented.");
  });

  it("handles synthetic system message block streamed in small chunks", () => {
    const sanitizer = new StreamSanitizer();
    const raw =
      "\n\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] task done\n</SYSTEM_MESSAGE>Assistant message preserved.";
    let output = "";
    const chunkSize = 15;
    for (let i = 0; i < raw.length; i += chunkSize) {
      output += sanitizer.process(raw.slice(i, i + chunkSize));
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("Assistant message preserved.");
  });

  it("handles synthetic system message block streamed in 1-char chunks", () => {
    const sanitizer = new StreamSanitizer();
    const raw =
      "\n\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user: context\n<SYSTEM_MESSAGE>task output</SYSTEM_MESSAGE>Clean message.";
    let output = "";
    for (const ch of raw) {
      output += sanitizer.process(ch);
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("Clean message.");
  });

  it("does not drop legitimate assistant text starting with 'The following'", () => {
    const sanitizer = new StreamSanitizer();
    const raw = "The following files were modified:\n- index.ts\n- index.test.ts";
    let output = "";
    for (let i = 0; i < raw.length; i += 5) {
      output += sanitizer.process(raw.slice(i, i + 5));
    }
    output += sanitizer.flush();
    expect(output).toBe(raw);
  });
});

describe("streamSanitizationFix", () => {
  it("resets sanitizer state on new prompt and cancellation to prevent swallowing subsequent turns", async () => {
    const fix = createStreamSanitizationFix();

    // Simulate an unclosed harness tag during an aborted turn
    const inboundChunk: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "<system_instruction>unclosed instruction" },
        },
      },
    } as unknown as AcpStreamMessage;
    const mockCtx = createMockContext();
    const filtered = fix.onInbound?.(inboundChunk, mockCtx);
    expect(filtered).toEqual([]);

    // Now user steers: outbound session/cancel arrives
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "s1" },
    } as unknown as AcpStreamMessage;
    fix.onOutbound?.(cancelMsg, mockCtx);

    const nextTurnChunk: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I was fixing a bug" },
        },
      },
    } as unknown as AcpStreamMessage;
    const kept = fix.onInbound?.(nextTurnChunk, mockCtx) as AcpStreamMessage[];
    expect(kept).toHaveLength(1);

    const updateParams = (kept[0] as unknown as { params?: SessionUpdateParams }).params;
    const content = updateParams?.update?.content as { text?: string };
    expect(content?.text).toBe("I was fixing a bug");
  });

  it("clears pending tag buffer when a new user prompt begins", () => {
    const fix = createStreamSanitizationFix();

    // Start with an unclosed tag
    fix.sanitizer.process("<system_message>some text");

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 200,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] },
    } as unknown as AcpStreamMessage;
    fix.onOutbound?.(promptMsg, createMockContext());

    // Sanitizer should now be clean
    expect(fix.sanitizer.process("Fresh response")).toBe("Fresh response");
  });

  it("provides system instructions restricting LaTeX math and unsupported Mermaid diagrams", () => {
    const fix = createStreamSanitizationFix();
    const instructions = fix.getSystemInstructions?.();
    expect(instructions).toBeDefined();
    expect(instructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("plain Unicode symbols instead of LaTeX"),
        expect.stringContaining("Mermaid diagrams"),
      ]),
    );
  });
});

describe("sanitizeText", () => {
  it("passes clean assistant output through without alterations", async () => {
    const { sanitizeText } = await import("./index.js");
    expect(sanitizeText("Hello, world!")).toBe("Hello, world!");
  });

  it("removes synthetic system message warning banners from assistant output", async () => {
    const { sanitizeText } = await import("./index.js");
    const input =
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user: context\nReal response";
    expect(sanitizeText(input)).toBe("Real response");
  });

  it("removes internal harness blocks and standalone markup tags", async () => {
    const { sanitizeText } = await import("./index.js");
    const input = "<task_output>secret</task_output>Visible text<scratchpad>inner</scratchpad>";
    expect(sanitizeText(input)).toBe("Visible text");
  });

  it("strips unclosed trailing harness tags to avoid UI formatting corruption", async () => {
    const { sanitizeText } = await import("./index.js");
    const input = "Visible before <context>trailing unfinished content";
    expect(sanitizeText(input)).toBe("Visible before");
  });

  it("strips leaked background task notification and raw stdout from assistant output", async () => {
    const { sanitizeText } = await import("./index.js");
    const raw = `Got a message from a background task:
[2be29f6b-8054-4a2b-96a8-a6fc359b605e/task-492] Output:
[INFO] Scanning for projects...
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
Task task-492 completed successfully with exit code 0.
All 145 tests passed!`;
    expect(sanitizeText(raw)).toBe("All 145 tests passed!");
  });

  it("suppresses streamed background task output without leaking raw logs", () => {
    const sanitizer = new StreamSanitizer();
    const raw = `Got a message from a background task:
[2be29f6b-8054-4a2b-96a8-a6fc359b605e/task-492] Output:
[INFO] Scanning for projects...
[INFO] Building Floci 2.1.0
Task task-492 completed successfully with exit code 0.
`;
    let output = "";
    for (let i = 0; i < raw.length; i += 20) {
      output += sanitizer.process(raw.slice(i, i + 20));
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("");
  });

  it("suppresses streamed background task output while preserving subsequent assistant text", () => {
    const sanitizer = new StreamSanitizer();
    const raw = `Got a message from a background task:
[2be29f6b-8054-4a2b-96a8-a6fc359b605e/task-492] Output:
[INFO] Scanning for projects...
Task task-492 completed successfully with exit code 0.
All 145 tests passed!`;
    let output = "";
    for (const ch of raw) {
      output += sanitizer.process(ch);
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("All 145 tests passed!");
  });

  it("strips task resumption banner and raw stdout from assistant output", async () => {
    const { sanitizeText } = await import("./index.js");
    const raw = `... Resuming execution after task execution ...
Background task 'f1914418-7ae0-4f1d-bb7a-0187b25f5786/task-214' has finished.
Exit code: 0
Task output:
[INFO] Scanning for projects...
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------`;
    expect(sanitizeText(raw)).toBe("");
  });

  it("suppresses streamed task resumption banner and output in 1-char chunks", () => {
    const sanitizer = new StreamSanitizer();
    const raw = `... Resuming execution after task execution ...
Background task 'f1914418-7ae0-4f1d-bb7a-0187b25f5786/task-214' has finished.
Exit code: 0
Task output:
[INFO] Scanning for projects...
[INFO] BUILD SUCCESS`;
    let output = "";
    for (const ch of raw) {
      output += sanitizer.process(ch);
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("");
  });

  it("preserves assistant text before task resumption banner", () => {
    const sanitizer = new StreamSanitizer();
    const raw = `Starting build now.
... Resuming execution after task execution ...
Background task 'f1914418-7ae0-4f1d-bb7a-0187b25f5786/task-214' has finished.
Exit code: 0
Task output:
[INFO] Scanning for projects...`;
    let output = "";
    for (const ch of raw) {
      output += sanitizer.process(ch);
    }
    output += sanitizer.flush();
    expect(output.trim()).toBe("Starting build now.");
  });

  it("does not drop legitimate assistant text containing ellipsis", () => {
    const sanitizer = new StreamSanitizer();
    const raw = "...thinking about the implementation details...";
    let output = "";
    for (const ch of raw) {
      output += sanitizer.process(ch);
    }
    output += sanitizer.flush();
    expect(output).toBe(raw);
  });
});
