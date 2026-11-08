import { describe, expect, it } from "vitest";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  type AcpStreamMessage,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createInterleavedStreamToolCallsFix } from "./index.js";

describe("interleaved-stream-tool-calls e2e", () => {
  it("problem: raw agy unbuffered stream interleaves tool calls into streaming assistant text", () => {
    // In raw ACP stream, an assistant message chunk is immediately followed by a tool call,
    // followed by another assistant message chunk, breaking message continuity in editor timelines.
    const rawEvents: AcpStreamMessage[] = [
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "test-sess",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { type: "text", text: "1. Local-only cap in ['.bazelrc ](file://" },
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "test-sess",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call_sub_1",
            name: "view_file",
            rawInput: { AbsolutePath: "/repo/auth.py" },
            status: "in_progress",
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "test-sess",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { type: "text", text: "auth.py) and more." },
          },
        },
      },
    ];

    const updates = rawEvents.map((m) =>
      "params" in m
        ? ((m.params as SessionUpdateParams).update as SessionUpdatePayload)
        : undefined,
    );

    expect(updates[0]?.sessionUpdate).toBe("agent_message_chunk");
    expect(updates[1]?.sessionUpdate).toBe("tool_call");
    expect(updates[2]?.sessionUpdate).toBe("agent_message_chunk");

    const content0 = updates[0]?.content as { text?: string } | undefined;
    const chunk0Text = content0?.text ?? "";
    expect(chunk0Text.endsWith("file://")).toBe(true);

    const content2 = updates[2]?.content as { text?: string } | undefined;
    const chunk2Text = content2?.text ?? "";
    expect(chunk2Text.startsWith("auth.py)")).toBe(true);
  });

  it("solution: interleavedStreamToolCallsFix buffers tool calls during active streaming and flushes them on turn completion", () => {
    const fix = createInterleavedStreamToolCallsFix();
    const sessionId = "test-sess";
    const context = createMockContext();

    const chunk1: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId,
        update: {
          sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
          content: { type: "text", text: "1. Local-only cap in ['.bazelrc ](file://" },
        },
      },
    };

    const toolCall: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId,
        update: {
          sessionUpdate: SESSION_UPDATES.TOOL_CALL,
          toolCallId: "call_sub_1",
          name: "view_file",
          rawInput: { AbsolutePath: "/repo/auth.py" },
          status: "in_progress",
        },
      },
    };

    const chunk2: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId,
        update: {
          sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
          content: { type: "text", text: "auth.py) and more." },
        },
      },
    };

    const promptResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      result: { stopReason: "end_turn" },
      params: { sessionId },
    } as unknown as AcpStreamMessage;

    // 1. Chunk 1 passes through
    const out1 = fix.onInbound?.(chunk1, context);
    expect(out1).toEqual([chunk1]);

    // 2. Tool call while streaming is buffered
    const outTool = fix.onInbound?.(toolCall, context);
    expect(outTool).toEqual([]);

    // 3. Chunk 2 passes through consecutively
    const out2 = fix.onInbound?.(chunk2, context);
    expect(out2).toEqual([chunk2]);

    // 4. Prompt response flushes buffered tool call first, then response
    const outFinal = fix.onInbound?.(promptResponse, context);
    expect(outFinal).toEqual([toolCall, promptResponse]);

    fix.dispose?.();
  });
});
