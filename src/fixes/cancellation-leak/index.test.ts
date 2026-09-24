import { describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { extractMessageChunkText, interruptionCleanupFix, isCancellationText } from "./index.js";

describe("isCancellationText", () => {
  it("detects concatenated upstream cancellation error text", () => {
    expect(isCancellationText("context canceledThe request was cancelled by the client.")).toBe(
      true,
    );
  });

  it("detects Python client-cancellation exception text", () => {
    expect(isCancellationText("The request was cancelled by the client.")).toBe(true);
    expect(isCancellationText("The request was cancelled by the client")).toBe(true);
  });

  it("detects Go context-cancellation error text", () => {
    expect(isCancellationText("context canceled")).toBe(true);
  });

  it("detects cancellation text even with surrounding whitespace padding", () => {
    expect(
      isCancellationText("   context canceledThe request was cancelled by the client.   \n"),
    ).toBe(true);
  });

  it("preserves legitimate assistant messages that discuss cancellation topics", () => {
    expect(isCancellationText("Here is the explanation for context cancellation in Go.")).toBe(
      false,
    );
    expect(isCancellationText("Done!")).toBe(false);
    expect(isCancellationText("")).toBe(false);
  });
});

describe("extractMessageChunkText", () => {
  it("extracts string payload from object-based message chunks", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBe("hello");
  });

  it("extracts concatenated string payload from multi-part array chunks", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [
            { type: "text", text: "foo" },
            { type: "text", text: "bar" },
          ],
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBe("foobar");
  });

  it("ignores non-message update variants", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBeNull();
  });
});

describe("interruptionCleanupFix", () => {
  it("suppresses raw combined cancellation error string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "context canceledThe request was cancelled by the client.",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("suppresses raw Python cancellation error string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "The request was cancelled by the client.",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("suppresses raw Go context canceled string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "context canceled",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("forwards legitimate assistant message chunks untouched", () => {
    const normalMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Hello! How can I help you?",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(normalMsg, createMockContext());
    expect(res).toEqual([normalMsg]);
  });

  it("synthesizes immediate cancelled prompt response when client cancels in-flight turn", () => {
    const fix = interruptionCleanupFix;
    let forwardedInbound: AcpStreamMessage | null = null;
    const mockCtx = {
      ...createMockContext(),
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedInbound = msg;
      },
    };

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 201,
      method: "session/prompt",
      params: { sessionId: "sess-cancel-test", prompt: [{ type: "text", text: "slow tool" }] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-cancel-test" },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(cancelMsg, mockCtx);

    expect(forwardedInbound).toEqual({
      jsonrpc: "2.0",
      id: 201,
      result: { stopReason: "cancelled" },
    });
  });

  it("drops late upstream response and late stream update chunks for cancelled turn", () => {
    const fix = interruptionCleanupFix;
    const mockCtx = createMockContext();

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 202,
      method: "session/prompt",
      params: { sessionId: "sess-drop-test", prompt: [{ type: "text", text: "slow tool" }] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-drop-test" },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(cancelMsg, mockCtx);

    // Late stream update chunk arrives from upstream -> dropped
    const lateChunk: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-drop-test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "tool output after cancel" },
        },
      },
    } as unknown as AcpStreamMessage;

    const chunkRes = fix.onInbound?.(lateChunk, mockCtx);
    expect(chunkRes).toEqual([]);

    // Late prompt response arrives from upstream -> dropped
    const lateResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 202,
      result: { stopReason: "cancelled" },
    } as unknown as AcpStreamMessage;

    const respRes = fix.onInbound?.(lateResponse, mockCtx);
    expect(respRes).toEqual([]);
  });
});
