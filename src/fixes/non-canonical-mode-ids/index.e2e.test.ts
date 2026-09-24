import { afterEach, describe, expect, it } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";
import type { AcpStreamMessage } from "../../core/types.js";

describe("non-canonical-mode-ids e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) await client.close().catch(() => {});
    }
  });

  it("problem: raw agy rejects non-canonical modeId 'accept-edits'", async () => {
    const rawClient = await spawnRawAgy();
    activeClients.push(rawClient);
    await rawClient.initialize();
    const { sessionId } = await rawClient.newSession();

    await rawClient.send({
      jsonrpc: "2.0",
      id: 201,
      method: "session/set_mode",
      params: { sessionId, modeId: "accept-edits" },
    } as unknown as AcpStreamMessage);

    const res = await rawClient.waitForResponse(201);
    expect("error" in res && res.error).toBeTruthy();
    await rawClient.close();
  });

  it("solution: wrapped connector normalizes 'accept-edits' to 'auto_edit' and succeeds", async () => {
    const wrappedClient = await spawnWrapped();
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();
    const { sessionId } = await wrappedClient.newSession();

    await wrappedClient.send({
      jsonrpc: "2.0",
      id: 202,
      method: "session/set_mode",
      params: { sessionId, modeId: "accept-edits" },
    } as unknown as AcpStreamMessage);

    const res = await wrappedClient.waitForResponse(202);
    expect("result" in res && res.result).toBeTruthy();
    await wrappedClient.close();
  });
});
