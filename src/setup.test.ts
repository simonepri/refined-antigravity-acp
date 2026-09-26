import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSetupBinary, runSetup, setupPaseo, setupZed, type ResolvedPaths } from "./setup.js";
import * as commandMod from "./core/command.js";

describe("setup CLI module", () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
    fakeHome = path.join(tempDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from(""));
    vi.spyOn(childProcess, "execSync").mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const mockPaths: ResolvedPaths = {
    nodePath: "/custom/bin/node",
    cliPath: "/custom/bin/refined-antigravity-acp",
  };

  it("configures Paseo with explicit node and script paths", () => {
    const success = setupPaseo(mockPaths, false);
    expect(success).toBe(true);

    const configPath = path.join(fakeHome, ".paseo", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.agents.providers["refined-antigravity-acp"]).toEqual({
      extends: "acp",
      label: "Antigravity",
      command: ["/custom/bin/node", "/custom/bin/refined-antigravity-acp"],
      enabled: true,
    });
  });

  it("preserves existing Paseo configuration and other providers", () => {
    const paseoDir = path.join(fakeHome, ".paseo");
    fs.mkdirSync(paseoDir, { recursive: true });
    const initialConfig = {
      version: 1,
      agents: {
        providers: {
          claude: { extends: "acp", label: "Claude", enabled: true },
        },
      },
    };
    fs.writeFileSync(path.join(paseoDir, "config.json"), JSON.stringify(initialConfig));

    setupPaseo(mockPaths, false);

    const config = JSON.parse(fs.readFileSync(path.join(paseoDir, "config.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.agents.providers.claude).toEqual({
      extends: "acp",
      label: "Claude",
      enabled: true,
    });
    expect(config.agents.providers["refined-antigravity-acp"].command).toEqual([
      "/custom/bin/node",
      "/custom/bin/refined-antigravity-acp",
    ]);
  });

  it("configures Zed settings with explicit command and args", () => {
    const success = setupZed(mockPaths);
    expect(success).toBe(true);

    const zedDir =
      process.platform === "darwin"
        ? path.join(fakeHome, "Library", "Application Support", "Zed")
        : path.join(fakeHome, ".config", "zed");
    const settingsPath = path.join(zedDir, "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.agent.profiles.antigravity).toEqual({
      type: "acp",
      command: "/custom/bin/node",
      args: ["/custom/bin/refined-antigravity-acp"],
    });
  });

  it("parses Zed JSON with single line comments", () => {
    const zedDir =
      process.platform === "darwin"
        ? path.join(fakeHome, "Library", "Application Support", "Zed")
        : path.join(fakeHome, ".config", "zed");
    fs.mkdirSync(zedDir, { recursive: true });
    const jsonWithComments = `// Zed Settings
{
  // Theme option
  "theme": "One Dark"
}
`;
    fs.writeFileSync(path.join(zedDir, "settings.json"), jsonWithComments);

    setupZed(mockPaths);

    const settings = JSON.parse(fs.readFileSync(path.join(zedDir, "settings.json"), "utf8"));
    expect(settings.theme).toBe("One Dark");
    expect(settings.agent.profiles.antigravity.command).toBe("/custom/bin/node");
  });

  describe("ensureSetupBinary and runSetup", () => {
    it("skips download when binary already exists", async () => {
      const existingBin = path.join(tempDir, "agy_acp_server.par");
      fs.writeFileSync(existingBin, "");
      process.env.REFINED_AGY_ACP_BIN = existingBin;
      try {
        const result = await ensureSetupBinary();
        expect(result).toBe(true);
      } finally {
        delete process.env.REFINED_AGY_ACP_BIN;
      }
    });

    it("fails when binary is missing in non-interactive environment without autoAccept", async () => {
      process.env.REFINED_AGY_ACP_BIN = path.join(tempDir, "nonexistent");
      try {
        const origTTY = process.stdin.isTTY;
        process.stdin.isTTY = false;
        try {
          const result = await ensureSetupBinary();
          expect(result).toBe(false);
        } finally {
          process.stdin.isTTY = origTTY;
        }
      } finally {
        delete process.env.REFINED_AGY_ACP_BIN;
      }
    });

    it("downloads binary when autoAccept is true", async () => {
      process.env.REFINED_AGY_ACP_BIN = path.join(tempDir, "nonexistent");
      const downloadSpy = vi
        .spyOn(commandMod, "ensureAntigravityBinary")
        .mockResolvedValue("/downloaded/bin");
      try {
        const result = await ensureSetupBinary({ autoAccept: true });
        expect(result).toBe(true);
        expect(downloadSpy).toHaveBeenCalled();
      } finally {
        delete process.env.REFINED_AGY_ACP_BIN;
      }
    });

    it("runSetup aborts if binary setup fails", async () => {
      process.env.REFINED_AGY_ACP_BIN = path.join(tempDir, "nonexistent");
      try {
        const origTTY = process.stdin.isTTY;
        process.stdin.isTTY = false;
        try {
          const result = await runSetup("all");
          expect(result).toBe(false);
          expect(fs.existsSync(path.join(fakeHome, ".paseo", "config.json"))).toBe(false);
        } finally {
          process.stdin.isTTY = origTTY;
        }
      } finally {
        delete process.env.REFINED_AGY_ACP_BIN;
      }
    });

    it("runSetup configures targets when autoAccept is true", async () => {
      process.env.REFINED_AGY_ACP_BIN = path.join(tempDir, "nonexistent");
      vi.spyOn(commandMod, "ensureAntigravityBinary").mockResolvedValue("/downloaded/bin");
      try {
        const result = await runSetup("all", { autoAccept: true, restartDaemon: false });
        expect(result).toBe(true);
        expect(fs.existsSync(path.join(fakeHome, ".paseo", "config.json"))).toBe(true);
      } finally {
        delete process.env.REFINED_AGY_ACP_BIN;
      }
    });
  });
});
