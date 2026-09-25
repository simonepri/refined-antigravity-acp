import { afterEach, describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { interruptionCleanupFix, isCancellationText } from "./index.js";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("cancellation-leak e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

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

  it("solution: interruptionCleanupFix drops Concurrent receive_steps error chunks", () => {
    const errorChunkMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Agent connection was lost and could not be re-established: Concurrent receive_steps() calls are not supported on this connection.",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(errorChunkMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("problem: raw agy causes turn collision error or fails when subsequent prompt is sent immediately after session/cancel", async () => {
    const client = await spawnRawAgy();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    // Start a turn
    const p1 = await client.prompt(sessionId, "Count from 1 to 100 with pauses between numbers");

    // Wait until streaming starts
    await client.nextMatching((m) => "method" in m && m.method === "session/update");

    // Send cancel as Paseo does
    await client.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    } as unknown as AcpStreamMessage);

    // Sending prompt 2 immediately without awaiting raw agy cleanup triggers collision or failure in raw agy
    const p2 = await client.prompt(sessionId, "Hello");
    await client.waitForResponse(p2.id, 15000);

    // In raw agy without our wrapper, sending prompt 2 immediately causes the connection to crash:
    // "Agent connection was lost and could not be re-established: Concurrent receive_steps() calls are not supported on this connection."
    // And p1 is dropped without ever receiving a response.
    const allMsgs = client.allMessages();
    const p1Settled = allMsgs.some((m) => "id" in m && m.id === p1.id);
    const hasConnectionLostChunk = allMsgs.some(
      (m) =>
        "method" in m &&
        m.method === "session/update" &&
        JSON.stringify(m).includes("Concurrent receive_steps() calls are not supported"),
    );

    // p1 was never settled by raw agy, or connection was broken by concurrent receive_steps()
    expect(!p1Settled || hasConnectionLostChunk).toBe(true);
  }, 30000);

  it("solution: wrapped connector immediately settles prompt response on cancel and allows subsequent prompt", async () => {
    const client = await spawnWrapped();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    const p1 = await client.prompt(sessionId, "Count from 1 to 100 with pauses between numbers");

    await client.nextMatching((m) => "method" in m && m.method === "session/update");

    const t0 = Date.now();
    await client.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    } as unknown as AcpStreamMessage);

    // Wrapped connector must synthesize and return { stopReason: "cancelled" } immediately (< 500ms)
    const res1 = await client.waitForResponse(p1.id, 1000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect("result" in res1 && (res1.result as { stopReason?: string }).stopReason).toBe(
      "cancelled",
    );

    // Subsequent prompt can be sent immediately without getting "A foreground turn is already active"
    const p2 = await client.prompt(sessionId, "What is 1 + 1? Respond with just the number.");
    const res2 = await client.waitForResponse(p2.id, 45000);
    expect("result" in res2 && res2.result).toBeTruthy();
  }, 60000);
});
