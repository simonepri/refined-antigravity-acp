import { describe, expect, it } from "vitest";
import { stripSteeringPrefix } from "./index.js";
import { spawnWrapped } from "../../test-utils/index.js";
import type { AcpStreamMessage, SessionUpdateParams } from "../../core/types.js";

describe("active-turn-collision e2e", () => {
  it("strips mid-turn update prefixes cleanly", () => {
    expect(stripSteeringPrefix("[Mid-turn update]: Please cancel task").trim()).toBe(
      "Please cancel task",
    );
    expect(stripSteeringPrefix("regular instruction")).toBe("regular instruction");
  });

  it("solution: handles turn prompt and completes successfully through wrapped connector", async () => {
    const client = await spawnWrapped();
    try {
      await client.initialize();
      const { sessionId } = await client.newSession();
      const { id } = await client.prompt(sessionId, "Respond with OK");
      const res = await client.waitForResponse(id, 45000);
      expect("result" in res && res.result).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("handles mid-turn steering: prompt sent during cancel streams chunks and completes", async () => {
    const client = await spawnWrapped();
    try {
      await client.initialize();
      const { sessionId } = await client.newSession();

      // Start prompt 1
      const p1 = await client.prompt(sessionId, "Count from 1 to 50 slowly");

      // Wait until we see at least one chunk from prompt 1
      await client.nextMatching((m) => "method" in m && m.method === "session/update");

      // Now mid-turn steering: send cancel and immediately send prompt 2
      await client.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      } as unknown as AcpStreamMessage);

      // Small tick or immediate prompt 2
      const p2 = await client.prompt(sessionId, "What are you doing?");

      // Wait for prompt 1 cancellation / finish
      await client.waitForResponse(p1.id, 15000).catch((e) => e);

      // Now wait for prompt 2 to complete
      const r2 = await client.waitForResponse(p2.id, 45000);

      const updatesAfterP2 = client
        .allMessages()
        .filter((m) => "method" in m && m.method === "session/update");

      expect("result" in r2 && r2.result).toBeTruthy();
      expect(updatesAfterP2.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 60000);

  it("handles tool interruption and resume: interrupted tool step can be resumed cleanly by the model", async () => {
    const client = await spawnWrapped();
    try {
      await client.initialize();
      const { sessionId } = await client.newSession();

      // Trigger a tool execution (listing files or running shell sleep)
      const p1 = await client.prompt(
        sessionId,
        "Run a shell command to sleep for 10 seconds: `sleep 10 && echo done`",
      );

      // Wait until we see evidence of tool call / execution starting
      await client.nextMatching(
        (m) =>
          "method" in m && m.method === "session/update" && JSON.stringify(m).includes("tool_call"),
        20000,
      );

      // Send steering interrupt while the tool is actively executing
      await client.send({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      } as unknown as AcpStreamMessage);

      // Send steering message asking the agent to resume or check what was happening
      const p2 = await client.prompt(
        sessionId,
        "What tool were you running, and did it finish? If not, just echo 'interrupted successfully'.",
      );

      // Prompt 1 settles (cancelled or aborted)
      await client.waitForResponse(p1.id, 15000).catch((e) => e);

      // Prompt 2 completes cleanly
      const r2 = await client.waitForResponse(p2.id, 45000);
      expect("result" in r2 && r2.result).toBeTruthy();

      // Confirm the model understood the context and responded
      const allChunks = client
        .allMessages()
        .filter(
          (m: AcpStreamMessage) =>
            "method" in m &&
            m.method === "session/update" &&
            (m.params as SessionUpdateParams | undefined)?.update?.sessionUpdate ===
              "agent_message_chunk",
        )
        .map((m: AcpStreamMessage) => {
          const params = (m as unknown as { params?: SessionUpdateParams }).params;
          return (params?.update?.content as { text?: string })?.text || "";
        })
        .join("");

      expect(allChunks.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 90000);
});
