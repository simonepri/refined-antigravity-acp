import { describe, expect, it } from "vitest";
import { ACP_METHODS, SESSION_UPDATES, type AcpStreamMessage } from "../../core/types.js";
import { createPrematureTurnStopFix } from "./index.js";

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
    // Simulates raw upstream behavior without any steering
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

  it("solution: proxy never invents or synthesizes fake assistant conversational text", () => {
    const fix = createPrematureTurnStopFix();
    // The fix must not register handlers that inject synthetic message chunks
    expect(fix.onInbound).toBeUndefined();
    expect(fix.onOutbound).toBeUndefined();
  });
});
