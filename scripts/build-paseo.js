#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const buildDir = path.join(rootDir, "build", "paseo");
const serverDir = path.join(buildDir, "server");
const assetsDir = path.join(buildDir, "assets");

// Ensure clean directories
fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(serverDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

// Copy src/*.ts (excluding *.test.ts) to build/paseo/server/
const srcDir = path.join(rootDir, "src");
const srcFiles = fs.readdirSync(srcDir);
for (const file of srcFiles) {
  if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
    fs.copyFileSync(path.join(srcDir, file), path.join(serverDir, file));
  }
}

// Copy assets/ to build/paseo/assets/
const rootAssetsDir = path.join(rootDir, "assets");
if (fs.existsSync(rootAssetsDir)) {
  const assetFiles = fs.readdirSync(rootAssetsDir);
  for (const file of assetFiles) {
    fs.copyFileSync(path.join(rootAssetsDir, file), path.join(assetsDir, file));
  }
}

// Read index.server.ts, rewrite ./src/ to ./server/, write to build/paseo/index.server.ts
const rootIndexServer = path.join(rootDir, "index.server.ts");
const indexServerContent = fs.readFileSync(rootIndexServer, "utf8");
const rewrittenIndexServer = indexServerContent.replaceAll("./src/", "./server/");
fs.writeFileSync(path.join(buildDir, "index.server.ts"), rewrittenIndexServer, "utf8");

// Read root paseo-plugin.json, omit "build", write to build/paseo/paseo-plugin.json
const rootManifestPath = path.join(rootDir, "paseo-plugin.json");
const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, "utf8"));
const { build: _ignoredBuild, ...paseoPluginJson } = rootManifest;
fs.writeFileSync(
  path.join(buildDir, "paseo-plugin.json"),
  JSON.stringify(paseoPluginJson, null, 2) + "\n",
  "utf8",
);

// If --install-root is passed (used by root paseo-plugin.json build step on git/remote install),
// also populate server/ and update index.server.ts at the install root so Paseo finds them.
if (process.argv.includes("--install-root")) {
  const rootServerDir = path.join(rootDir, "server");
  fs.rmSync(rootServerDir, { recursive: true, force: true });
  fs.cpSync(serverDir, rootServerDir, { recursive: true });
  fs.writeFileSync(rootIndexServer, rewrittenIndexServer, "utf8");
}
