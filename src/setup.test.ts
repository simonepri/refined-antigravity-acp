import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPaseo, setupZed, type ResolvedPaths } from "./setup.js";

describe("setup CLI module", () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
    fakeHome = path.join(tempDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
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
});
