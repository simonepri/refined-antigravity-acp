import { afterEach, describe, expect, it } from "vitest";
import { spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("noisy-stderr-logs e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("solution: wrapped connector drops raw websocket debug spam from stderr", async () => {
    const client = await spawnWrapped({ env: { REFINED_AGY_TRACE: "0" } });
    activeClients.push(client);
    await client.initialize();

    const { sessionId } = await client.newSession();
    await client.prompt(sessionId, "hello");

    const lines = client.stderrLines().join("\n");
    expect(lines).not.toMatch(/RAW WS MSG:/);
    await client.close();
  });
});
