import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { agyCommand } from "../../core/command.js";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

describe("missing-localharness e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("problem: raw agy binary in isolated directory without sibling harness crashes on session/new", async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-isolated-"));
    const [origBin] = agyCommand();
    const isolatedBin = path.join(isolatedDir, path.basename(origBin));
    fs.copyFileSync(origBin, isolatedBin);
    fs.chmodSync(isolatedBin, 0o755);

    const rawClient = await spawnRawAgy({
      cmd: isolatedBin,
      env: { ANTIGRAVITY_HARNESS_PATH: "" },
    });
    activeClients.push(rawClient);
    await rawClient.initialize();
    await expect(rawClient.newSession()).rejects.toThrow(/localharness/i);
    await rawClient.close();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("solution: wrapped connector automatically resolves ANTIGRAVITY_HARNESS_PATH and succeeds", async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-isolated-"));
    const [origBin] = agyCommand();
    const isolatedBin = path.join(isolatedDir, path.basename(origBin));
    fs.copyFileSync(origBin, isolatedBin);
    fs.chmodSync(isolatedBin, 0o755);

    const wrappedClient = await spawnWrapped({
      cmd: isolatedBin,
      env: { ANTIGRAVITY_HARNESS_PATH: "" },
    });
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();
    const res = await wrappedClient.newSession();
    expect(res.sessionId).toBeDefined();
    await wrappedClient.close();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  });
});
