import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";

export interface ResolvedPaths {
  nodePath: string;
  cliPath?: string | undefined;
}

export function resolvePaths(): ResolvedPaths {
  const nodePath = process.execPath;
  let cliPath: string | undefined;

  // 1. Check if process.argv[1] is an actual existing file
  const scriptArg = process.argv[1];
  if (scriptArg && fs.existsSync(scriptArg)) {
    try {
      cliPath = fs.realpathSync(scriptArg);
    } catch {
      cliPath = scriptArg;
    }
  }

  // 2. Check which refined-antigravity-acp
  if (!cliPath) {
    try {
      const found = execSync("which refined-antigravity-acp", { encoding: "utf8" }).trim();
      if (found && fs.existsSync(found)) {
        cliPath = fs.realpathSync(found);
      }
    } catch {}
  }

  return { nodePath, cliPath };
}

function parseJsonWithComments(content: string): Record<string, unknown> {
  const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return {};
  }
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return parseJsonWithComments(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function getNestedRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = obj[key];
  return (val && typeof val === "object" ? val : {}) as Record<string, unknown>;
}

function tryRestartPaseoDaemon(): void {
  try {
    execFileSync("paseo", ["daemon", "restart"], { stdio: "ignore" });
    console.log("✓ Restarted Paseo daemon");
  } catch {
    // Paseo daemon may not be active or paseo CLI not in PATH
  }
}

export function setupPaseo(paths: ResolvedPaths = resolvePaths(), restartDaemon = true): boolean {
  const paseoDir = path.join(os.homedir(), ".paseo");
  const configPath = path.join(paseoDir, "config.json");

  fs.mkdirSync(paseoDir, { recursive: true });

  const config = readJsonFile(configPath);
  const agents = getNestedRecord(config, "agents");
  const providers = getNestedRecord(agents, "providers");

  const command = paths.cliPath
    ? [paths.nodePath, paths.cliPath]
    : ["pnpm", "dlx", "@simonepri/refined-antigravity-acp"];

  providers["refined-antigravity-acp"] = {
    extends: "acp",
    label: "Antigravity",
    command,
    enabled: true,
  };

  agents.providers = providers;
  config.agents = agents;

  writeJsonFile(configPath, config);
  console.log(`✓ Configured Paseo provider in ${configPath}`);

  if (restartDaemon) {
    tryRestartPaseoDaemon();
  }

  return true;
}

function resolveZedDir(): string {
  const homeDir = os.homedir();
  const macDir = path.join(homeDir, "Library", "Application Support", "Zed");
  const linuxDir = path.join(homeDir, ".config", "zed");
  const zedDirs = [macDir, linuxDir];

  const found = zedDirs.find((d) => fs.existsSync(d));
  if (found) {
    return found;
  }

  const defaultDir = process.platform === "darwin" ? macDir : linuxDir;
  fs.mkdirSync(defaultDir, { recursive: true });
  return defaultDir;
}

export function setupZed(paths: ResolvedPaths = resolvePaths()): boolean {
  const targetDir = resolveZedDir();
  const settingsPath = path.join(targetDir, "settings.json");

  const settings = readJsonFile(settingsPath);
  const agent = getNestedRecord(settings, "agent");
  const profiles = getNestedRecord(agent, "profiles");

  const command = paths.cliPath ? paths.nodePath : "pnpm";
  const args = paths.cliPath ? [paths.cliPath] : ["dlx", "@simonepri/refined-antigravity-acp"];

  profiles.antigravity = {
    type: "acp",
    command,
    args,
  };

  agent.profiles = profiles;
  settings.agent = agent;

  writeJsonFile(settingsPath, settings);
  console.log(`✓ Configured Zed profile in ${settingsPath}`);

  return true;
}

export async function runSetup(target: "all" | "paseo" | "zed" = "all"): Promise<void> {
  const paths = resolvePaths();

  if (target === "paseo") {
    setupPaseo(paths);
  } else if (target === "zed") {
    setupZed(paths);
  } else {
    setupPaseo(paths);
    setupZed(paths);
  }
}
