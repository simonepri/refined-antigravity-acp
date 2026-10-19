import { describe, expect, it, vi } from "vitest";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  STOP_REASONS,
  type AcpStreamMessage,
} from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { buildContinuationText, createPrematureTurnStopFix } from "./index.js";

function makeToolCallUpdate(
  sessionId: string,
  toolCallId: string,
  status: string,
  title?: string,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
        toolCallId,
        status,
        title,
      },
    },
  };
}

function makeToolCall(sessionId: string, toolCallId: string, title: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL,
        toolCallId,
        title,
        status: "in_progress",
      },
    },
  };
}

function makeMessageChunk(sessionId: string, text: string): AcpStreamMessage {
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
  };
}

function makePromptResult(id: string | number, stopReason = "endTurn"): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      stopReason,
    },
  };
}

describe("premature-turn-stop reproduction and verification", () => {
  const sessionId = "session-test-repro";

  it("problem: raw upstream terminates prompt turn after tool calls without emitting assistant text", () => {
    const inboundMessages: AcpStreamMessage[] = [];

    // 1. Tool execution completes
    const toolUpdate = makeToolCallUpdate(
      sessionId,
      "call_1",
      "completed",
      "Run pre-commit checks",
    );
    inboundMessages.push(toolUpdate);

    // 2. Upstream immediately completes prompt turn with empty AgentStep (stopReason=16)
    const promptResult = makePromptResult(1, "endTurn");
    inboundMessages.push(promptResult);

    // Check what was delivered to the client:
    const messageChunks = inboundMessages.filter(
      (m) =>
        "params" in m &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
    );

    // DEMONSTRATION OF DEFECT:
    // Zero assistant messages emitted. Client UI enters idle state with complete silence.
    expect(messageChunks).toHaveLength(0);
    expect(inboundMessages.at(-1)).toEqual(promptResult);
  });

  it("solution: fix provides explicit system prompt steering to prevent silent turn completion", () => {
    const fix = createPrematureTurnStopFix();
    const instructions = fix.getSystemInstructions?.();

    expect(instructions).toBeDefined();
    expect(instructions?.length).toBeGreaterThan(0);
    expect(
      instructions?.some((i) =>
        i.includes("Never end a prompt turn without emitting a clear assistant text message"),
      ),
    ).toBe(true);
  });

  it("solution: buildContinuationText produces actionable continuation directives", () => {
    const text = buildContinuationText(15);
    expect(text).toContain("[Automated Continuation]");
    expect(text).toContain("15 tool calls");
    expect(text).toContain("summarize what you have accomplished");
  });

  it("solution: intercepts premature empty turn stop, dispatches continuation prompt upstream, and preserves turn", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];

    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    // 1. Client initiates prompt turn
    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 101,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Deploy cluster" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    // 2. Model executes tool calls
    await fix.onInbound?.(makeToolCall(sessionId, "t1", "Running k3s-entrypoint"), context);
    await fix.onInbound?.(makeToolCallUpdate(sessionId, "t1", "completed"), context);

    // 3. Upstream tries to terminate turn prematurely with stopReason: "endTurn" and 0 text
    const emptyResult = makePromptResult(101, STOP_REASONS.END_TURN);
    const intercepted = await fix.onInbound?.(emptyResult, context);

    // Result suppressed from client!
    expect(intercepted).toEqual([]);

    // Continuation prompt dispatched upstream to child process
    expect(writtenToChild).toHaveLength(1);
    expect(writtenToChild[0]).toMatchObject({
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId,
        prompt: [{ type: "text" }],
      },
    });

    const promptText = (
      writtenToChild[0] as unknown as { params: { prompt: Array<{ text: string }> } }
    ).params.prompt[0]?.text;
    expect(promptText).toContain("[Automated Continuation]");
    expect(promptText).toContain("1 tool calls");

    // 4. Upstream responds to continuation with assistant text
    await fix.onInbound?.(
      makeMessageChunk(sessionId, "Cluster deploy finished successfully."),
      context,
    );

    // 5. Upstream completes continuation prompt
    const continuationPromptId = (writtenToChild[0] as unknown as { id: string }).id;
    const continuationComplete = makePromptResult(continuationPromptId, STOP_REASONS.END_TURN);
    const finalResult = await fix.onInbound?.(continuationComplete, context);

    // Client receives final result with original prompt ID restored!
    expect(finalResult).toHaveLength(1);
    expect(finalResult?.[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 101,
      result: { stopReason: STOP_REASONS.END_TURN },
    });
  });

  it("solution: does not trigger continuation when turn already emitted assistant text", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 202,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Check status" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    // Tool call followed by text chunk
    await fix.onInbound?.(makeToolCall(sessionId, "t2", "Running status"), context);
    await fix.onInbound?.(makeMessageChunk(sessionId, "All services healthy."), context);

    // Upstream finishes
    const normalResult = makePromptResult(202, STOP_REASONS.END_TURN);
    const result = await fix.onInbound?.(normalResult, context);

    // Passthrough unchanged, no continuation sent
    expect(result).toEqual([normalResult]);
    expect(writtenToChild).toHaveLength(0);
  });

  it("solution: does not trigger continuation when cancelled by user", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 303,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Long task" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    await fix.onInbound?.(makeToolCall(sessionId, "t3", "Running long job"), context);

    // User cancels
    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_CANCEL,
        params: { sessionId },
      } as unknown as AcpStreamMessage,
      context,
    );

    const cancelResult = makePromptResult(303, STOP_REASONS.CANCELLED);
    const result = await fix.onInbound?.(cancelResult, context);

    expect(result).toEqual([cancelResult]);
    expect(writtenToChild).toHaveLength(0);
  });

  it("solution: intercepts premature stop when model only emits whitespace chunks after tools", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 404,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Why do we need this?" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    // 10 tool calls executed
    for (let i = 0; i < 10; i++) {
      await fix.onInbound?.(makeToolCall(sessionId, `call_${i}`, `Tool ${i}`), context);
      await fix.onInbound?.(makeToolCallUpdate(sessionId, `call_${i}`, "completed"), context);
    }

    // Model only emits whitespace chunk ("\n")
    await fix.onInbound?.(makeMessageChunk(sessionId, "\n"), context);

    // Upstream attempts to finish turn
    const emptyResult = makePromptResult(404, "endTurn");
    const intercepted = await fix.onInbound?.(emptyResult, context);

    expect(intercepted).toEqual([]);
    expect(writtenToChild).toHaveLength(1);

    const promptText = (
      writtenToChild[0] as unknown as { params: { prompt: Array<{ text: string }> } }
    ).params.prompt[0]?.text;
    expect(promptText).toContain("[Automated Continuation]");
    expect(promptText).toContain("10 tool calls");
  });

  it("solution: does not trigger continuation when turn has no tool calls", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 505,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Pure question" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    // No tool calls, turn finishes
    const normalResult = makePromptResult(505, "end_turn");
    const result = await fix.onInbound?.(normalResult, context);

    expect(result).toEqual([normalResult]);
    expect(writtenToChild).toHaveLength(0);
  });

  it("solution: triggers continuation even when prompt instructions contain keywords like stop or wait", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 606,
        method: ACP_METHODS.SESSION_PROMPT,
        params: {
          sessionId,
          prompt: [
            {
              type: "text",
              text: "To wait for the timer, you must stop calling tools to end your turn. make a plan to optimize the mobile view",
            },
          ],
        },
      } as unknown as AcpStreamMessage,
      context,
    );

    // Tools ran
    await fix.onInbound?.(makeToolCall(sessionId, "call_stop_1", "Tool 1"), context);
    await fix.onInbound?.(makeToolCallUpdate(sessionId, "call_stop_1", "completed"), context);

    // Turn completes without text
    const stopResult = makePromptResult(606, "end_turn");
    const result = await fix.onInbound?.(stopResult, context);

    // Suppressed and continuation sent
    expect(result).toEqual([]);
    expect(writtenToChild).toHaveLength(1);
    const promptText = (
      writtenToChild[0] as unknown as { params: { prompt: Array<{ text: string }> } }
    ).params.prompt[0]?.text;
    expect(promptText).toContain("[Automated Continuation]");
  });

  it("solution: correctly detects assistant text when emitted as an array of content blocks", async () => {
    const fix = createPrematureTurnStopFix();
    const context = createMockContext();
    const writtenToChild: AcpStreamMessage[] = [];
    context.writeToChild = vi.fn().mockImplementation(async (msg) => {
      writtenToChild.push(msg);
    });

    await fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 707,
        method: ACP_METHODS.SESSION_PROMPT,
        params: { sessionId, prompt: [{ type: "text", text: "Check status" }] },
      } as unknown as AcpStreamMessage,
      context,
    );

    // Tools ran
    await fix.onInbound?.(makeToolCall(sessionId, "call_707", "Status check"), context);
    await fix.onInbound?.(makeToolCallUpdate(sessionId, "call_707", "completed"), context);

    // Upstream emits content as an array of blocks (common in ACP)
    await fix.onInbound?.(
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId,
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: [{ type: "text", text: "# Status Report\nAll healthy." }],
          },
        },
      } as unknown as AcpStreamMessage,
      context,
    );

    const normalResult = makePromptResult(707, "end_turn");
    const result = await fix.onInbound?.(normalResult, context);

    // Properly detected text, no continuation dispatched
    expect(result).toEqual([normalResult]);
    expect(writtenToChild).toHaveLength(0);
  });
});
