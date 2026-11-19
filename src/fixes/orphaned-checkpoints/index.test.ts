import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CoreContext } from "../../core/types.js";
import {
  extractGenMetadataStepIndices,
  extractExecutorMetadataStepIdx,
  orphanedCheckpointsFix,
} from "./index.js";
import { encodeLengthDelimited } from "../../lib/protobuf.js";

describe("extractGenMetadataStepIndices", () => {
  it("decodes single varint step index in field 2", () => {
    const data = encodeLengthDelimited(2, Buffer.from([0x0a])); // step 10
    const indices = extractGenMetadataStepIndices(data);
    expect(indices.stepIdx).toBe(10);
  });

  it("decodes multiple packed repeated varints in field 2 and returns maximum", () => {
    // Packed repeated varints: 10, 20, 999 (0xe7, 0x07), 15
    const packed = Buffer.from([0x0a, 0x14, 0xe7, 0x07, 0x0f]);
    const data = encodeLengthDelimited(2, packed);
    const indices = extractGenMetadataStepIndices(data);
    expect(indices.stepIdx).toBe(999);
  });

  it("returns null if field 2 is empty or absent", () => {
    const data = new Uint8Array([0x08, 0x01]); // field 1 tag only
    const indices = extractGenMetadataStepIndices(data);
    expect(indices.stepIdx).toBeNull();
  });
});

describe("extractExecutorMetadataStepIdx", () => {
  it("extracts step index from field 3 varint", () => {
    const data = Buffer.concat([Buffer.from([0x18]), Buffer.from([0x2a])]); // tag 24 (field 3), val 42
    expect(extractExecutorMetadataStepIdx(data)).toBe(42);
  });

  it("returns null if field 3 is absent", () => {
    const data = Buffer.concat([Buffer.from([0x08]), Buffer.from([0x01])]); // tag 8 (field 1), val 1
    expect(extractExecutorMetadataStepIdx(data)).toBeNull();
  });
});

describe("orphanedCheckpointsFix.onRecycle", () => {
  it("repairs session database on recycle", async () => {
    const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
    const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
    fs.mkdirSync(convDir, { recursive: true });

    const sess = "unit-recycle-" + Date.now();
    const dbPath = path.join(convDir, sess + ".db");

    const d = new DatabaseSync(dbPath);
    d.exec(
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
    );
    d.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");

    // Step up to 10
    d.prepare(
      "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (10, 3, 15, NULL);",
    ).run();

    // gen_metadata with packed varints [10, 999] where first is valid but second is OOB
    const oobGen = encodeLengthDelimited(2, Buffer.from([0x0a, 0xe7, 0x07]));
    d.prepare("INSERT INTO gen_metadata (idx, data) VALUES (1, ?);").run(oobGen);
    d.close();

    // Call onRecycle
    await orphanedCheckpointsFix.onRecycle?.(
      {
        sessionId: sess,
        lastConfigOptions: new Map(),
        fixData: new Map(),
      },
      null as unknown as ChildProcess,
      null as unknown as CoreContext,
    );

    const checkDb = new DatabaseSync(dbPath, { readOnly: true });
    const genRows = checkDb.prepare("SELECT idx FROM gen_metadata;").all();
    checkDb.close();

    expect(genRows).toHaveLength(0);
    fs.rmSync(dbPath, { force: true });
  });
});
