import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("repetitive-tool-loop e2e", () => {
  const activeClients: AcpTestClient[] = [];
  let testDir: string | null = null;

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
      testDir = null;
    }
  });

  it("problem: raw agy executes repetitive tool calling cycles indefinitely without loop detection", async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-repro-"));
    const filePath = path.join(testDir, "numbers.txt");
    fs.writeFileSync(
      filePath,
      `Section A:
1: Alpha
2: Beta
3: Gamma
4: Delta
5: Epsilon

Section B:
1: Alpha
2: Beta
3: Gamma
4: Delta
5: Epsilon
`,
    );

    const client = await spawnRawAgy({ cwd: testDir });
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: testDir });

    await client.prompt(
      sessionId,
      `Compare Section A (lines 1 to 7) and Section B (lines 8 to 14) of ${filePath}.
Alternate between reading Section A and Section B using view_file at least 5 times in a row before concluding.`,
    );

    // Wait until at least 6 tool calls have occurred or prompt settles
    const startTime = Date.now();
    let toolCalls: AcpStreamMessage[] = [];
    while (Date.now() - startTime < 35000) {
      toolCalls = client.allMessages().filter((m) => {
        return (
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
            "tool_call"
        );
      });
      if (toolCalls.length >= 6) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`Raw agy observed tool calls: ${toolCalls.length}`);

    // Upstream raw agy has no loop detection and will execute 6+ repetitive/cyclic tool calls
    expect(toolCalls.length).toBeGreaterThanOrEqual(6);
  }, 45000);

  it("solution: wrapped connector detects repetitive tool loop, cancels upstream, emits warning chunk, and settles cleanly", async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-sol-"));
    const filePath = path.join(testDir, "numbers.txt");
    fs.writeFileSync(
      filePath,
      `Section A:
1: Alpha
2: Beta
3: Gamma
4: Delta
5: Epsilon

Section B:
1: Alpha
2: Beta
3: Gamma
4: Delta
5: Epsilon
`,
    );

    const client = await spawnWrapped({ cwd: testDir });
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: testDir });

    const p = await client.prompt(
      sessionId,
      `Compare Section A (lines 1 to 7) and Section B (lines 8 to 14) of ${filePath}.
Alternate between reading Section A and Section B using view_file at least 5 times in a row before concluding.`,
    );

    // Await prompt completion
    const res = await client.waitForResponse(p.id, 45000);
    expect("result" in res && res.result).toBeTruthy();

    const allMsgs = client.allMessages();
    const toolCalls = allMsgs.filter(
      (m) =>
        "method" in m &&
        m.method === "session/update" &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ===
          "tool_call",
    );

    // The wrapped connector should cap the tool calls (interrupting at repetition 3)
    // and not allow runaway cyclic calls
    expect(toolCalls.length).toBeLessThanOrEqual(6);

    // An assistant message chunk explaining the loop interruption should be emitted
    const hasLoopInterruptionChunk = allMsgs.some((m) => {
      if (!("method" in m) || m.method !== "session/update") return false;
      const update = (
        m.params as {
          update?: { sessionUpdate?: string; content?: { text?: string } };
        }
      )?.update;
      return (
        update?.sessionUpdate === "agent_message_chunk" &&
        typeof update.content?.text === "string" &&
        update.content.text.includes("repetitive tool calling loop")
      );
    });
    expect(hasLoopInterruptionChunk).toBe(true);

    // Subsequent prompt can be sent immediately without getting "A foreground turn is already active"
    const p2 = await client.prompt(sessionId, "What is 2 + 2? Answer with just the number.");
    const res2 = await client.waitForResponse(p2.id, 45000);
    expect("result" in res2 && res2.result).toBeTruthy();
  }, 60000);
});
