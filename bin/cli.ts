#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli().catch((err) => {
  console.error("[refined-antigravity-acp] Fatal error:", err);
  process.exit(1);
});
