import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Resolves the path to the ACP token JSON file under the Gemini home directory.
 */
export function getAcpTokenPath(): string {
  const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
  return path.join(geminiHome, "antigravity-acp", "acp_token.json");
}

/**
 * Checks if the local ACP token file contains an active refresh token.
 */
export function hasValidRefreshToken(tokenPath: string = getAcpTokenPath()): boolean {
  if (!fs.existsSync(tokenPath)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    return typeof existing.refresh_token === "string" && existing.refresh_token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extracts the CLI refresh token from macOS Keychain if available.
 */
function extractClientId(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return typeof payload.aud === "string" ? payload.aud : undefined;
  } catch {
    return undefined;
  }
}

export function readKeychainCredentials(): { refreshToken: string; clientId?: string } | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    ).trim();

    if (!raw) return null;
    const b64 = raw.replace(/^go-keyring-base64:/, "");
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    const refreshToken = parsed?.token?.refresh_token;
    if (!refreshToken) return null;

    const clientId = extractClientId(parsed.id_token);
    return { refreshToken, clientId };
  } catch {
    return null;
  }
}

/**
 * Writes an authorized_user credential blob to the ACP token path with mode 0600.
 */
export function writeAcpTokenFile(
  tokenPath: string,
  refreshToken: string,
  clientId?: string,
): void {
  const acpBlob: Record<string, unknown> = {
    refresh_token: refreshToken,
    type: "authorized_user",
  };
  if (clientId) {
    acpBlob.client_id = clientId;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, JSON.stringify(acpBlob, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Ignore chmod failure on filesystems that do not support POSIX modes
  }
}

/**
 * Syncs credentials from the official `agy` CLI's Keychain entry (`antigravity`)
 * into `~/.gemini/antigravity-acp/acp_token.json` if the token file is missing or invalid.
 */
export function syncAgyCredentials(): boolean {
  const tokenPath = getAcpTokenPath();
  if (hasValidRefreshToken(tokenPath)) {
    return true;
  }

  const creds = readKeychainCredentials();
  if (!creds) {
    return false;
  }

  try {
    writeAcpTokenFile(tokenPath, creds.refreshToken, creds.clientId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the user is authenticated with Antigravity before starting the ACP server.
 * Throws an actionable error directing the user to run `agy` in their terminal.
 */
export function ensureAuthenticated(): void {
  const ok = syncAgyCredentials();
  if (!ok && !hasValidRefreshToken(getAcpTokenPath())) {
    throw new Error(
      "Not logged in to Google Antigravity. Please run 'agy' in your terminal to log in.",
    );
  }
}
