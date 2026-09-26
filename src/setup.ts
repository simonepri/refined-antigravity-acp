import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import readline from "node:readline/promises";
import { agyCommand, ensureAntigravityBinary } from "./core/command.js";

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
      const found = childProcess
        .execSync("which refined-antigravity-acp", { encoding: "utf8" })
        .trim();
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
    childProcess.execFileSync("paseo", ["daemon", "restart"], { stdio: "ignore" });
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

export const GOOGLE_TERMS_URL = "https://antigravity.google/terms";

export interface SetupOptions {
  autoAccept?: boolean | undefined;
  restartDaemon?: boolean | undefined;
}

function findExistingBinary(): string | undefined {
  try {
    const [cmd] = agyCommand();
    return fs.existsSync(cmd) ? cmd : undefined;
  } catch {
    return undefined;
  }
}

async function promptTermsAcceptance(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `\nGoogle Antigravity ACP binary was not found locally.\nBy downloading, you agree to the Google Antigravity Terms of Service:\n  ${GOOGLE_TERMS_URL}\n\nTo accept non-interactively, pass --yes: refined-antigravity-acp setup --yes\n`,
    );
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `\nGoogle Antigravity ACP binary was not found locally.\nTo continue, the official binary must be downloaded from Google (dl.google.com).\n\nNotice: By downloading, you agree to the Google Antigravity Terms of Service:\n  ${GOOGLE_TERMS_URL}\n\nDo you accept the Google Antigravity Terms of Service? [y/N]: `,
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

export async function ensureSetupBinary(options?: SetupOptions): Promise<boolean> {
  const existingCmd = findExistingBinary();
  if (existingCmd) {
    console.log(`✓ Google Antigravity ACP binary found: ${existingCmd}`);
    return true;
  }

  const accepted = options?.autoAccept ?? (await promptTermsAcceptance());
  if (!accepted) {
    console.log("\nSetup cancelled: Google Antigravity Terms of Service were not accepted.");
    return false;
  }

  console.log(`\nNotice: By downloading, you agree to the Google Antigravity Terms of Service:`);
  console.log(`  ${GOOGLE_TERMS_URL}`);
  console.log("\n⬇ Downloading official Google Antigravity ACP binary...");
  try {
    const installed = await ensureAntigravityBinary();
    console.log(`✓ Installed agy_acp_server to ${installed}\n`);
    return true;
  } catch (err) {
    console.error(`✗ Failed to download Antigravity ACP binary:`, err);
    return false;
  }
}

export async function runSetup(
  target: "all" | "paseo" | "zed" = "all",
  options?: SetupOptions,
): Promise<boolean> {
  const binaryOk = await ensureSetupBinary(options);
  if (!binaryOk) {
    return false;
  }

  const paths = resolvePaths();
  const restartDaemon = options?.restartDaemon ?? true;

  if (target === "paseo") {
    setupPaseo(paths, restartDaemon);
  } else if (target === "zed") {
    setupZed(paths);
  } else {
    setupPaseo(paths, restartDaemon);
    setupZed(paths);
  }

  return true;
}
