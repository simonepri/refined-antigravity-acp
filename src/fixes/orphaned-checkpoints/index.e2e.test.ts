import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { repairOrphanedCheckpoints } from "./index.js";
import { encodeLengthDelimited } from "../../test-utils/index.js";

describe("orphaned-checkpoints e2e", () => {
  describe("Fatal doneCh Panic & Orphaned Checkpoint Repair", () => {
    it("problem: raw orphaned in-progress checkpoints remain un-repaired at status IN_PROGRESS", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sessRepair = "e2e-repair-raw-" + Date.now();
      const dbPath = path.join(convDir, sessRepair + ".db");

      const d = new DatabaseSync(dbPath);
      d.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
      );
      const validPayload = encodeLengthDelimited(
        19,
        encodeLengthDelimited(2, Buffer.from("repair test", "utf-8")),
      );
      d.prepare(
        "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 2, 23, ?);",
      ).run(validPayload);
      d.close();

      const rawDb = new DatabaseSync(dbPath, { readOnly: true });
      const rawRow = rawDb.prepare("SELECT status FROM steps WHERE idx = 1;").get() as {
        status: number;
      };
      rawDb.close();
      expect(rawRow.status).toBe(2);

      fs.rmSync(dbPath, { force: true });
    });

    it("solution: repairOrphanedCheckpoints automatically repairs orphaned checkpoints to status ABORTED", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sessRepair = "e2e-repair-fix-" + Date.now();
      const dbPath = path.join(convDir, sessRepair + ".db");

      const d = new DatabaseSync(dbPath);
      d.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
      );
      const validPayload = encodeLengthDelimited(
        19,
        encodeLengthDelimited(2, Buffer.from("repair test", "utf-8")),
      );
      d.prepare(
        "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 2, 23, ?);",
      ).run(validPayload);
      d.close();

      const count = repairOrphanedCheckpoints(sessRepair);
      expect(count).toBe(1);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const checkRow = checkDb.prepare("SELECT status FROM steps WHERE idx = 1;").get() as {
        status: number;
      };
      checkDb.close();
      expect(checkRow.status).toBe(5);

      fs.rmSync(dbPath, { force: true });
    });

    it("solution: repairOrphanedCheckpoints also repairs orphaned action/tool steps (step_type=21) to status ABORTED", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sessRepair = "e2e-repair-tool-" + Date.now();
      const dbPath = path.join(convDir, sessRepair + ".db");

      const d = new DatabaseSync(dbPath);
      d.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
      );
      d.prepare(
        "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 2, 21, NULL);",
      ).run();
      d.close();

      const count = repairOrphanedCheckpoints(sessRepair);
      expect(count).toBe(1);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const checkRow = checkDb.prepare("SELECT status FROM steps WHERE idx = 1;").get() as {
        status: number;
      };
      checkDb.close();
      expect(checkRow.status).toBe(5);

      fs.rmSync(dbPath, { force: true });
    });

    it("solution: repairOrphanedCheckpoints resets interrupted execution step payloads to aborted status so resumption succeeds", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sessRepair = "e2e-repair-proto-" + Date.now();
      const dbPath = path.join(convDir, sessRepair + ".db");

      const d = new DatabaseSync(dbPath);
      d.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
      );
      // Byte 0: 0x08 (type=23), Byte 2: 0x20 (tag status), Byte 3: 0x02 (IN_PROGRESS)
      const payload = Buffer.from([0x08, 0x17, 0x20, 0x02, 0x2a, 0x01]);
      d.prepare(
        "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 5, 23, ?);",
      ).run(payload);
      d.close();

      const count = repairOrphanedCheckpoints(sessRepair);
      expect(count).toBe(1);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      const checkRow = checkDb
        .prepare("SELECT status, step_payload FROM steps WHERE idx = 1;")
        .get() as {
        status: number;
        step_payload: Uint8Array;
      };
      checkDb.close();
      expect(checkRow.status).toBe(5);
      expect(checkRow.step_payload[3]).toBe(5);

      fs.rmSync(dbPath, { force: true });
    });
  });

  describe("Checkpoint Repair Session Isolation", () => {
    it("problem: naive global repair would mutate all conversation databases across all open tabs", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sess1 = "e2e-iso-1-" + Date.now();
      const sess2 = "e2e-iso-2-" + Date.now();
      const db1 = path.join(convDir, sess1 + ".db");
      const db2 = path.join(convDir, sess2 + ".db");

      const validPayload = encodeLengthDelimited(
        19,
        encodeLengthDelimited(2, Buffer.from("isolation test", "utf-8")),
      );
      for (const p of [db1, db2]) {
        const d = new DatabaseSync(p);
        d.exec(
          "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
        );
        d.prepare(
          "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 2, 23, ?);",
        ).run(validPayload);
        d.close();
      }

      repairOrphanedCheckpoints(sess1);

      const d2 = new DatabaseSync(db2, { readOnly: true });
      const row2 = d2.prepare("SELECT status FROM steps WHERE idx = 1;").get() as {
        status: number;
      };
      d2.close();

      expect(row2.status).toBe(2);

      fs.rmSync(db1, { force: true });
      fs.rmSync(db2, { force: true });
    });

    it("solution: scoped checkpoint repair mutates strictly target session while leaving concurrent sessions untouched", () => {
      const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
      const convDir = path.join(geminiHome, "antigravity-acp", "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      const sess1 = "e2e-iso-target-" + Date.now();
      const sess2 = "e2e-iso-other-" + Date.now();
      const db1 = path.join(convDir, sess1 + ".db");
      const db2 = path.join(convDir, sess2 + ".db");

      const validPayload = encodeLengthDelimited(
        19,
        encodeLengthDelimited(2, Buffer.from("isolation test", "utf-8")),
      );
      for (const p of [db1, db2]) {
        const d = new DatabaseSync(p);
        d.exec(
          "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, status INTEGER, step_type INTEGER, step_payload BLOB);",
        );
        d.prepare(
          "INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 2, 23, ?);",
        ).run(validPayload);
        d.close();
      }

      repairOrphanedCheckpoints(sess1);

      const d1 = new DatabaseSync(db1, { readOnly: true });
      const row1 = d1.prepare("SELECT status FROM steps WHERE idx = 1;").get() as {
        status: number;
      };
      d1.close();

      expect(row1.status).toBe(5);

      fs.rmSync(db1, { force: true });
      fs.rmSync(db2, { force: true });
    });
  });
});
