#!/usr/bin/env node

import readline from "node:readline";
import { createAntigravityConnector } from "../src/connector.js";

async function main(): Promise<void> {
  const connector = createAntigravityConnector();
  const stream = await connector();

  const reader = stream.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(JSON.stringify(value) + "\n");
      }
    } catch (err) {
      console.error("[refined-antigravity-acp] Stdio readable stream error:", err);
      process.exit(1);
    }
  })();

  const writer = stream.writable.getWriter();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      writer.write(msg).catch((err) => {
        console.error("[refined-antigravity-acp] Failed to forward ACP message:", err);
      });
    } catch {
      // Drop malformed input line
    }
  });

  rl.on("close", async () => {
    try {
      await writer.close();
    } catch {
      // Writer may already be closed
    }
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch((err) => {
  console.error("[refined-antigravity-acp] Fatal error:", err);
  process.exit(1);
});
