import { describe, expect, it } from "vitest";
import { ACP_METHODS, SESSION_UPDATES, type AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createPrematureTurnStopFix } from "./index.js";

function makePromptRequest(
  id: string | number,
  sessionId: string,
  promptText: string,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: ACP_METHODS.SESSION_PROMPT,
    params: {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    },
  };
}

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
  const dummyContext = createMockContext();
  const sessionId = "session-test-repro";

  it("problem: raw upstream terminates prompt turn after tool calls without emitting assistant text", () => {
    // Simulates raw upstream behavior without any intercepting fix
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

  it("problem: raw upstream terminates prompt turn immediately with zero output on direct prompt", () => {
    // Simulates raw upstream behavior on prompt like 'hello?'
    const inboundMessages: AcpStreamMessage[] = [];

    // Upstream returns prompt completion without any intermediate chunks
    const promptResult = makePromptResult(2, "endTurn");
    inboundMessages.push(promptResult);

    const messageChunks = inboundMessages.filter(
      (m) =>
        "params" in m &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
    );

    // DEMONSTRATION OF DEFECT:
    // Prompt ended immediately with 0 output
    expect(messageChunks).toHaveLength(0);
  });

  it("solution: fix synthesizes status explanation before prompt completion when turn is empty", async () => {
    const fix = createPrematureTurnStopFix();

    // 1. Track outbound prompt
    const promptReq = makePromptRequest(10, sessionId, "commit the changes");
    await fix.onOutbound!(promptReq, dummyContext);

    // 2. Tool calls happen
    const toolMsg = makeToolCallUpdate(sessionId, "call_81", "completed", "Run bazel checks");
    const forwardedTool = await fix.onInbound!(toolMsg, dummyContext);
    expect(forwardedTool).toEqual([toolMsg]);

    // 3. Upstream returns premature turn end without emitting any assistant message
    const emptyResult = makePromptResult(10, "endTurn");
    const forwardedResult = await fix.onInbound!(emptyResult, dummyContext);

    // Solution verification:
    // The fix must synthesize an assistant message chunk before the result
    expect(forwardedResult.length).toBeGreaterThanOrEqual(2);
    const firstMsg = forwardedResult[0] as {
      params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
    };
    expect(firstMsg.params?.update?.sessionUpdate).toBe(SESSION_UPDATES.AGENT_MESSAGE_CHUNK);
    expect(firstMsg.params?.update?.content?.text).toContain("Completed actions");
    expect(forwardedResult.at(-1)).toEqual(emptyResult);
  });

  it("solution: does not synthesize duplicate message if assistant already spoke", async () => {
    const fix = createPrematureTurnStopFix();

    // 1. Track outbound prompt
    const promptReq = makePromptRequest(20, sessionId, "status?");
    await fix.onOutbound!(promptReq, dummyContext);

    // 2. Assistant emits a message chunk
    const chunk = makeMessageChunk(sessionId, "All checks passed.");
    await fix.onInbound!(chunk, dummyContext);

    // 3. Upstream returns prompt completion
    const promptResult = makePromptResult(20, "endTurn");
    const forwardedResult = await fix.onInbound!(promptResult, dummyContext);

    // No duplicate synthesis needed because assistant spoke
    expect(forwardedResult).toEqual([promptResult]);
  });
});
