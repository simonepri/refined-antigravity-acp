import { afterEach, describe, expect, it } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("ask_question unhandled collision e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("problem: raw agy halts on ask_question and rejects subsequent chat prompts with foreground turn active", async () => {
    const client = await spawnRawAgy();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    // Model is prompted to ask a question
    await client.prompt(
      sessionId,
      "Please call the ask_question tool immediately to ask what color I prefer (Red or Blue). Do not generate any other text before calling the tool.",
    );

    // Wait until the ask_question tool call is emitted
    const toolCallMsg = await client.nextMatching(
      (m) =>
        "method" in m &&
        m.method === "session/update" &&
        JSON.stringify(m).includes("ask_question"),
      30000,
    );

    expect(toolCallMsg).toBeDefined();

    // Now user types a response into chat rather than selecting a button
    const p2 = await client.prompt(
      sessionId,
      "I prefer Green actually, please proceed with Green.",
    );

    // In raw agy, this second prompt is rejected with foreground turn active or hangs indefinitely
    const res2 = await client.waitForResponse(p2.id, 10000);
    expect("error" in res2 && res2.error).toBeTruthy();
    if ("error" in res2 && res2.error) {
      expect(JSON.stringify(res2.error)).toContain("foreground turn is already active");
    }
  }, 45000);

  it("solution: wrapped agy auto-cancels pending question and executes user prompt cleanly", async () => {
    const client = await spawnWrapped();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    // Model is prompted to ask a question
    await client.prompt(
      sessionId,
      "Please call the ask_question tool immediately to ask what color I prefer (Red or Blue). Do not generate any other text before calling the tool.",
    );

    // Wait until the ask_question tool call is emitted
    const toolCallMsg = await client.nextMatching(
      (m) =>
        "method" in m &&
        m.method === "session/update" &&
        JSON.stringify(m).includes("ask_question"),
      30000,
    );

    expect(toolCallMsg).toBeDefined();

    // Now user types a response into chat rather than selecting a button
    const p2 = await client.prompt(
      sessionId,
      "I prefer Green actually, please proceed with Green.",
    );

    // With the fix, p2 resolves successfully
    const res2 = await client.waitForResponse(p2.id, 45000);
    expect("result" in res2 && res2.result).toBeTruthy();
  }, 90000);
});
