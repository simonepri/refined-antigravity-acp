import readline from "node:readline";
import { createAntigravityConnector } from "./index.js";

export async function runCli(): Promise<void> {
  const connector = createAntigravityConnector();
  const stream = await connector();

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const writeStdout = (async () => {
    for await (const value of stream.readable) {
      process.stdout.write(JSON.stringify(value) + "\n");
    }
  })();

  const writer = stream.writable.getWriter();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  const readStdin = (async () => {
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
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
  })();

  await Promise.all([writeStdout, readStdin]);
}
