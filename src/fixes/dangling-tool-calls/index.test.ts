import { describe, expect, it } from "vitest";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  type AcpStreamMessage,
  type SessionUpdateParams,
} from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createToolCallCleanupFix } from "./index.js";

function makeToolCallMessage(
  sessionId: string,
  toolCallId: string,
  status?: string,
  rawOutput?: unknown,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL,
        toolCallId,
        status,
        rawOutput,
      },
    },
  };
}

function makeToolCallUpdateMessage(
  sessionId: string,
  toolCallId: string,
  status?: string,
  rawOutput?: unknown,
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
        rawOutput,
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

describe("dangling-tool-calls fix", () => {
  const dummyContext = createMockContext();

  it("passes through completed tool calls without modification", () => {
    const fix = createToolCallCleanupFix();
    const sessionId = "s1";

    const callMsg = makeToolCallMessage(sessionId, "call_1", "in_progress");
    const out1 = fix.onInbound!(callMsg, dummyContext) as AcpStreamMessage[];
    expect(out1).toEqual([callMsg]);

    const updateMsg = makeToolCallUpdateMessage(sessionId, "call_1", "completed");
    const out2 = fix.onInbound!(updateMsg, dummyContext) as AcpStreamMessage[];
    expect(out2).toEqual([updateMsg]);

    const endMessages = fix.onTurnEnd!(sessionId, dummyContext);
    expect(endMessages).toEqual([]);
  });

  it("marks backgrounded tool calls completed immediately so the tool spinner clears in the UI", () => {
    const fix = createToolCallCleanupFix();
    const sessionId = "s1";

    const bgOutput =
      "Created At: 2026-09-24T02:00:00Z\nTool is running as a background task with task id: s1/task-123\nTask Description: run tests";
    const updateMsg = makeToolCallUpdateMessage(sessionId, "call_bg", undefined, bgOutput);

    const out = fix.onInbound!(updateMsg, dummyContext) as AcpStreamMessage[];
    expect(out).toHaveLength(1);
    const update = (out[0] as unknown as { params?: SessionUpdateParams }).params?.update as {
      status?: string;
    };
    expect(update?.status).toBe("completed");

    // onTurnEnd should not emit duplicate completions
    const endMessages = fix.onTurnEnd!(sessionId, dummyContext);
    expect(endMessages).toEqual([]);
  });

  it("closes dangling in-progress tool calls before delivering assistant messages to prevent stuck spinners", () => {
    const fix = createToolCallCleanupFix();
    const sessionId = "s1";

    // 1. Tool call starts without terminal status
    const callMsg = makeToolCallMessage(sessionId, "call_dangling", "in_progress");
    fix.onInbound!(callMsg, dummyContext);

    // 2. Assistant starts speaking
    const chunkMsg = makeMessageChunk(sessionId, "I am waiting for the test suite to finish...");
    const out = fix.onInbound!(chunkMsg, dummyContext) as AcpStreamMessage[];

    expect(out).toHaveLength(2);
    // First message must be synthesized tool completion
    expect(out[0]).toMatchObject({
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId,
        update: {
          sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
          toolCallId: "call_dangling",
          status: "completed",
        },
      },
    });
    // Second message must be the chunk
    expect(out[1]).toBe(chunkMsg);

    // onTurnEnd should have nothing left to flush
    const endMessages = fix.onTurnEnd!(sessionId, dummyContext);
    expect(endMessages).toEqual([]);
  });

  it("closes uncompleted tool calls when the prompt turn ends to prevent infinite spinners in client UI", () => {
    const fix = createToolCallCleanupFix();
    const sessionId = "s1";

    const callMsg = makeToolCallMessage(sessionId, "call_end_flush", "in_progress");
    fix.onInbound!(callMsg, dummyContext);

    const endMessages = fix.onTurnEnd!(sessionId, dummyContext);
    expect(endMessages).toHaveLength(1);
    expect(endMessages[0]).toMatchObject({
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId,
        update: {
          sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
          toolCallId: "call_end_flush",
          status: "completed",
        },
      },
    });
  });

  it("preserves cancelled tool state without synthetic completions when the user cancels the turn", () => {
    const fix = createToolCallCleanupFix();
    const sessionId = "s1";

    const callMsg = makeToolCallMessage(sessionId, "call_cancelled", "in_progress");
    fix.onInbound!(callMsg, dummyContext);

    // Turn cancelled by client
    fix.onOutbound!(
      {
        jsonrpc: "2.0",
        id: 1,
        method: ACP_METHODS.SESSION_CANCEL,
        params: { sessionId },
      },
      dummyContext,
    );

    const endMessages = fix.onTurnEnd!(sessionId, dummyContext);
    expect(endMessages).toEqual([]);
  });

  it("isolates uncompleted tool calls across concurrent sessions", () => {
    const fix = createToolCallCleanupFix();
    fix.onInbound!(makeToolCallMessage("s1", "call_1", "in_progress"), dummyContext);
    fix.onInbound!(makeToolCallMessage("s2", "call_2", "in_progress"), dummyContext);

    const s1End = fix.onTurnEnd!("s1", dummyContext);
    expect(s1End).toHaveLength(1);
    const s1Update = (s1End[0] as unknown as { params?: SessionUpdateParams }).params?.update as {
      toolCallId?: string;
    };
    expect(s1Update?.toolCallId).toBe("call_1");

    // s2 is untouched and can still be flushed
    const s2End = fix.onTurnEnd!("s2", dummyContext);
    expect(s2End).toHaveLength(1);
    const s2Update = (s2End[0] as unknown as { params?: SessionUpdateParams }).params?.update as {
      toolCallId?: string;
    };
    expect(s2Update?.toolCallId).toBe("call_2");
  });
});
