import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";
import { CLIENT_NAME_ENV } from "./index.js";

type ConfigOptions = Array<{ id?: string; options?: Array<{ value?: string }> }>;

function modelIds(res: Record<string, unknown>): string[] {
  const configOptions = (res.configOptions as ConfigOptions | undefined) ?? [];
  const modelOpt = configOptions.find((o) => o.id === "model");
  return (modelOpt?.options ?? []).map((o) => o.value ?? "").filter(Boolean);
}

describe("gated-third-party-models e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) await client.close().catch(() => {});
    }
  });

  it("problem: raw agy offers only Gemini models to a client that is not Zed, Xcode or JetBrains", async () => {
    const rawClient = await spawnRawAgy();
    activeClients.push(rawClient);
    await rawClient.initialize({ name: "test-client", version: "1.0.0" });
    const res = await rawClient.newSession();

    const ids = modelIds(res);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("gemini"))).toBe(true);

    await rawClient.close();
  });

  it("solution: wrapped connector with REFINED_AGY_CLIENT_NAME=zed exposes non-Gemini models", async () => {
    vi.stubEnv(CLIENT_NAME_ENV, "zed");
    const wrappedClient = await spawnWrapped();
    activeClients.push(wrappedClient);
    await wrappedClient.initialize({ name: "test-client", version: "1.0.0" });
    const res = await wrappedClient.newSession();

    const ids = modelIds(res);
    expect(ids.some((id) => !id.startsWith("gemini"))).toBe(true);

    await wrappedClient.close();
  });
});
