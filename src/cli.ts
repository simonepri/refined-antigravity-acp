import readline from "node:readline";
import { createAntigravityConnector } from "./index.js";
import { runSetup } from "./setup.js";

function parseSetupTarget(args: string[]): "all" | "paseo" | "zed" {
  if (args.includes("paseo") || args.includes("--paseo")) return "paseo";
  if (args.includes("zed") || args.includes("--zed")) return "zed";
  return "all";
}

function printHelp(): void {
  console.log(`Refined Antigravity ACP - Hardened wrapper around Google's official Antigravity ACP binary.

Usage:
  refined-antigravity-acp               Start ACP server over stdio
  refined-antigravity-acp setup         Download binary & configure Paseo and Zed
  refined-antigravity-acp setup paseo   Configure Paseo (~/.paseo/config.json)
  refined-antigravity-acp setup zed     Configure Zed Editor (settings.json)

Options:
  -y, --yes                             Accept Google Terms of Service non-interactively
`);
}

async function handleCliArgs(args: string[]): Promise<boolean> {
  const firstArg = args[0]?.toLowerCase();

  if (firstArg === "setup") {
    const autoAccept = args.includes("--yes") || args.includes("-y");
    const target = parseSetupTarget(args);
    const success = await runSetup(target, { autoAccept });
    if (!success) {
      process.exit(1);
    }
    return true;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return true;
  }

  return false;
}

async function pipeStdinToWriter(writer: WritableStreamDefaultWriter<unknown>): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const msg = JSON.parse(trimmed);
        await writer.write(msg);
      } catch {
        // Drop malformed input line or forward error
      }
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // Writer may already be closed
    }
  }
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (await handleCliArgs(args)) {
    return;
  }

  const connector = createAntigravityConnector();
  const stream = await connector();

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const writeStdout = (async () => {
    for await (const value of stream.readable) {
      process.stdout.write(JSON.stringify(value) + "\n");
    }
  })();

  const readStdin = pipeStdinToWriter(stream.writable.getWriter());

  await Promise.all([writeStdout, readStdin]);
}
