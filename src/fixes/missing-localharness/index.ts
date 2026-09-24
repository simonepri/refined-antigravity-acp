/**
 * Problem:
 * Upstream `agy_acp_server` requires a sibling companion binary (`localharness_external`).
 * When relocated or invoked from an isolated directory without `$ANTIGRAVITY_HARNESS_PATH`
 * explicitly set, spawning or creating a session fails with a fatal exit.
 *
 * Solution:
 * Automatically inspects the binary directory and standard installation directories
 * to locate `localharness_external`, exporting `$ANTIGRAVITY_HARNESS_PATH` on process spawn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agyCommand, ensureAntigravityBinary } from "../../core/command.js";
import type { AcpFix } from "../../core/types.js";

const HARNESS_NAMES =
  process.platform === "win32"
    ? ["localharness_external.exe", "localharness_external", "localharness.exe", "localharness"]
    : ["localharness_external", "localharness", "localharness_external.exe"];

function findHarnessInDir(dir: string): string | undefined {
  for (const name of HARNESS_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveFromCommand(cmd?: string): string | undefined {
  if (!cmd || !fs.existsSync(cmd)) return undefined;
  try {
    const real = fs.realpathSync(cmd);
    return findHarnessInDir(path.dirname(real));
  } catch {
    return undefined;
  }
}

function resolveFromSearchDirs(): string | undefined {
  const searchDirs = [
    path.join(os.homedir(), ".local", "share", "antigravity-acp"),
    path.join("/opt", "homebrew", "bin"),
    path.join("/usr", "local", "bin"),
  ];
  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      const found = findHarnessInDir(dir);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * The harness (`localharness_external`) ships next to the Google server binary.
 * Resolve it relative to the executable command or standard installation paths.
 */
export function resolveHarnessPath(cmd?: string): string | undefined {
  const envHarness = process.env.ANTIGRAVITY_HARNESS_PATH?.trim();
  if (envHarness && fs.existsSync(envHarness)) {
    return envHarness;
  }

  const fromCmd = resolveFromCommand(cmd);
  if (fromCmd) return fromCmd;

  try {
    const [original] = agyCommand();
    const fromOriginal = resolveFromCommand(original);
    if (fromOriginal) return fromOriginal;
  } catch {
    // Ignore resolution errors
  }

  return resolveFromSearchDirs();
}

export const missingLocalharnessFix: AcpFix = {
  name: "missing-localharness",
  description: "Automatically resolves and exports $ANTIGRAVITY_HARNESS_PATH sibling binary",

  onSpawn(env: NodeJS.ProcessEnv, cmd: string): void {
    const current = env.ANTIGRAVITY_HARNESS_PATH?.trim();
    if (current && fs.existsSync(current)) {
      return;
    }
    const harness = resolveHarnessPath(cmd);
    if (harness) {
      env.ANTIGRAVITY_HARNESS_PATH = harness;
    }
  },
};

export const harnessResolutionFix = missingLocalharnessFix;

export async function resolveBinaryCommand(): Promise<[string, ...string[]]> {
  const [initialCmd, ...args] = agyCommand();
  let cmd = initialCmd;
  if (!fs.existsSync(cmd)) {
    try {
      cmd = await ensureAntigravityBinary();
    } catch (err) {
      console.error("[refined-antigravity-acp] Failed to auto-download binary:", err);
    }
  }
  return [cmd, ...args];
}
