import { describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { interruptionCleanupFix, isCancellationText } from "./index.js";

describe("cancellation-leak e2e", () => {
  it("problem: raw agy emits raw cancellation error text ('context canceledThe request was cancelled by the client.') on interruption", () => {
    const rawErrorChunk = "context canceledThe request was cancelled by the client.";
    expect(isCancellationText(rawErrorChunk)).toBe(true);
  });

  it("solution: interruptionCleanupFix drops raw cancellation error chunks during turn interruptions", () => {
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
});
