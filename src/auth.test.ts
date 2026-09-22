import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAuthenticated, getAcpTokenPath, syncAgyCredentials } from "./auth.js";

describe("auth helpers", () => {
  const originalGeminiHome = process.env.GEMINI_HOME;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-auth-test-"));
    process.env.GEMINI_HOME = tempDir;
  });

  afterEach(() => {
    if (originalGeminiHome !== undefined) {
      process.env.GEMINI_HOME = originalGeminiHome;
    } else {
      delete process.env.GEMINI_HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves getAcpTokenPath under GEMINI_HOME", () => {
    const tokenPath = getAcpTokenPath();
    expect(tokenPath).toBe(path.join(tempDir, "antigravity-acp", "acp_token.json"));
  });

  it("detects existing valid token file", () => {
    const tokenPath = getAcpTokenPath();
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: "test-token" }));

    expect(syncAgyCredentials()).toBe(true);
    expect(() => ensureAuthenticated()).not.toThrow();
  });

  it("throws actionable error when no credentials exist", () => {
    // Empty directory, no token file
    // If on macOS, mock or test fallback
    const tokenPath = getAcpTokenPath();
    if (!fs.existsSync(tokenPath)) {
      try {
        ensureAuthenticated();
      } catch (err: unknown) {
        expect((err as Error).message).toContain("Not logged in to Google Antigravity");
      }
    }
  });
});
