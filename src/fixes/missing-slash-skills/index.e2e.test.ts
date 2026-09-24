import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

interface CommandEntry {
  name?: string;
  [key: string]: unknown;
}

interface UpdatePayload {
  sessionUpdate?: string;
  available_commands_update?: CommandEntry[];
  availableCommands?: CommandEntry[];
  [key: string]: unknown;
}

interface SessionUpdateMessage {
  method?: string;
  params?: {
    update?: UpdatePayload;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

describe("missing-slash-skills e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("problem: raw agy omits custom workspace SKILL.md commands in available_commands_update", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-raw-"));
    const skillDir = path.join(testDir, ".agents", "skills", "deploy");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy to production\n---\nDeploy instructions.",
    );

    const rawClient = await spawnRawAgy({ cwd: testDir });
    activeClients.push(rawClient);
    await rawClient.initialize();
    await rawClient.newSession({ cwd: testDir });

    const rawCommands = (rawClient.allMessages() as unknown as SessionUpdateMessage[])
      .filter(
        (m) =>
          m.method === "session/update" &&
          (m.params?.update?.sessionUpdate === "available_commands_update" ||
            m.params?.update?.available_commands_update ||
            m.params?.update?.availableCommands),
      )
      .flatMap(
        (m) =>
          m.params?.update?.availableCommands ?? m.params?.update?.available_commands_update ?? [],
      );

    const rawHasDeploy = rawCommands.some((c) => c.name === "deploy" || c.name === "/deploy");
    expect(rawHasDeploy).toBe(false);
    await rawClient.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("solution: wrapped connector discovers workspace skills and augments available_commands_update", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-skills-wrapped-"));
    const skillDir = path.join(testDir, ".agents", "skills", "deploy");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy to production\n---\nDeploy instructions.",
    );

    const wrappedClient = await spawnWrapped({ cwd: testDir });
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();
    await wrappedClient.newSession({ cwd: testDir });

    const wrappedCommands = (wrappedClient.allMessages() as unknown as SessionUpdateMessage[])
      .filter(
        (m) =>
          m.method === "session/update" &&
          (m.params?.update?.sessionUpdate === "available_commands_update" ||
            m.params?.update?.available_commands_update ||
            m.params?.update?.availableCommands),
      )
      .flatMap(
        (m) =>
          m.params?.update?.availableCommands ?? m.params?.update?.available_commands_update ?? [],
      );

    const wrappedHasDeploy = wrappedCommands.some(
      (c) => c.name === "deploy" || c.name === "/deploy",
    );
    expect(wrappedHasDeploy).toBe(true);
    await wrappedClient.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});
