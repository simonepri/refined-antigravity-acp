import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BINARY_URLS: Record<string, string> = {
  "darwin-arm64":
    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
  "linux-x64":
    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip",
  "linux-arm64":
    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip",
  "win32-x64":
    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip",
  "win32-arm64":
    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip",
};

export function getPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const key = `${platform}-${arch}`;
  return BINARY_URLS[key] ? key : null;
}

export function extractZip(zipPath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  try {
    execFileSync("tar", ["-xf", zipPath, "-C", targetDir], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", targetDir], { stdio: "ignore" });
  }
}

async function downloadBinaryZip(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download Antigravity ACP binary: HTTP ${res.status}`);
  }
  const tempZip = path.join(os.tmpdir(), `agy-acp-${Date.now()}.zip`);
  fs.writeFileSync(tempZip, Buffer.from(await res.arrayBuffer()));
  return tempZip;
}

export async function ensureAntigravityBinary(): Promise<string> {
  const platformKey = getPlatformKey();
  const url = platformKey ? BINARY_URLS[platformKey] : null;
  if (!url) {
    throw new Error(
      `Unsupported platform for Antigravity ACP: ${process.platform} (${process.arch})`,
    );
  }

  const installDir = path.join(os.homedir(), ".local", "share", "antigravity-acp");
  const tempZip = await downloadBinaryZip(url);
  try {
    extractZip(tempZip, installDir);
  } finally {
    fs.rmSync(tempZip, { force: true });
  }

  const binaryName = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
  const binaryPath = path.join(installDir, binaryName);
  if (process.platform !== "win32" && fs.existsSync(binaryPath)) {
    fs.chmodSync(binaryPath, 0o755);
  }
  return binaryPath;
}

function resolveExecutable(platform: NodeJS.Platform, override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const defaultName = platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
  const candidates = [
    path.join(os.homedir(), ".local", "share", "antigravity-acp", defaultName),
    path.join("/opt", "homebrew", "bin", defaultName),
    path.join("/usr", "local", "bin", defaultName),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? defaultName;
}

export function agyCommand(
  platform: NodeJS.Platform = process.platform,
  override = process.env.PASEO_AGY_ACP_BIN,
): readonly [string, ...string[]] {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(`Antigravity ACP server does not support ${platform}`);
  }
  const executable = resolveExecutable(platform, override);
  return platform === "linux" ? [executable, "--uid="] : [executable];
}
