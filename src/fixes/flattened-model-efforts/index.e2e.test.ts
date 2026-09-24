import { afterEach, describe, expect, it } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("flattened-model-efforts e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) await client.close().catch(() => {});
    }
  });

  it("problem: raw agy returns flattened model IDs and lacks thought_level configuration option", async () => {
    const rawClient = await spawnRawAgy();
    activeClients.push(rawClient);
    await rawClient.initialize();
    const res = await rawClient.newSession();

    const configOptions =
      (res.configOptions as Array<{ id?: string; options?: Array<{ value?: string }> }>) ?? [];
    const hasThoughtLevel = configOptions.some((o) => o.id === "thought_level");
    expect(hasThoughtLevel).toBe(false);

    const modelOpt = configOptions.find((o) => o.id === "model");
    const hasFlattened = modelOpt?.options?.some(
      (opt) => opt.value?.endsWith("-high") || opt.value?.endsWith("-low"),
    );
    expect(hasFlattened).toBe(true);

    await rawClient.close();
  });

  it("solution: wrapped connector collapses model list and exposes thought_level option", async () => {
    const wrappedClient = await spawnWrapped();
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();
    const res = await wrappedClient.newSession();

    const configOptions =
      (res.configOptions as Array<{ id?: string; options?: Array<{ value?: string }> }>) ?? [];
    const thoughtOpt = configOptions.find((o) => o.id === "thought_level");
    expect(thoughtOpt).toBeDefined();
    expect(thoughtOpt?.options?.map((o) => o.value)).toEqual(["high", "medium", "low"]);

    const modelOpt = configOptions.find((o) => o.id === "model");
    const hasFlattened = modelOpt?.options?.some(
      (opt) => opt.value?.endsWith("-high") || opt.value?.endsWith("-low"),
    );
    expect(hasFlattened).toBe(false);

    await wrappedClient.close();
  });
});
