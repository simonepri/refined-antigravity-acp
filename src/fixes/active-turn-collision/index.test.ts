import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, InboundContext } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createUserSteeringFix, stripSteeringPrefix } from "./index.js";

describe("stripSteeringPrefix", () => {
  it("strips client-injected mid-turn steering prefixes from user prompts", () => {
    expect(stripSteeringPrefix("[Mid-turn update]: Stop doing that").trim()).toBe(
      "Stop doing that",
    );
    expect(stripSteeringPrefix("regular instruction")).toBe("regular instruction");
  });
});

describe("userSteeringFix", () => {
  const dummyContext = createMockContext();

  it("tracks prompt requests and forwards successful turn responses without collision", async () => {
    const fix = createUserSteeringFix();
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] },
    } as unknown as AcpStreamMessage;

    const out = fix.onOutbound?.(promptMsg, dummyContext);
    expect(out).toBe(promptMsg);

    const normalResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;

    const res = await fix.onInbound?.(normalResponse, dummyContext);
    expect(res).toEqual([normalResponse]);
  });

  it("suppresses upstream collision error and retries user prompt when user steers mid-turn", async () => {
    const fix = createUserSteeringFix({ delayMs: 10 });
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 102,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "what are you doing?" }] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(promptMsg, dummyContext);

    let writtenToChild: AcpStreamMessage | null = null;
    const testContext: InboundContext = {
      sessionCache: {
        sessions: new Map(),
        pendingSessionMetadata: new Map(),
        pendingRequestSessions: new Map(),
      },
      forwardInbound: () => {},
      writeToChild: async (msg) => {
        writtenToChild = msg;
      },
      sendInternalRequest: async () => ({}) as AcpStreamMessage,
      triggerRecycle: async () => {},
      declareHang: () => {},
    };

    const collisionError: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 102,
      error: { code: -32000, message: "foreground turn is already active" },
    } as unknown as AcpStreamMessage;

    const res = await fix.onInbound?.(collisionError, testContext);
    expect(res).toEqual([]); // Error is suppressed

    // Wait for the retry timer
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(writtenToChild).toEqual(promptMsg);
    // Crucial check: pendingRequestSessions has been restored so the final turn end can be attributed!
    expect(testContext.sessionCache.pendingRequestSessions.get(102)).toBe("s1");
  });

  it("provides system instructions requiring direct acknowledgment of mid-turn updates", () => {
    const fix = createUserSteeringFix();
    const instructions = fix.getSystemInstructions?.();
    expect(instructions).toBeDefined();
    expect(instructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("acknowledge and address it directly in your response"),
      ]),
    );
  });
});
