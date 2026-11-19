/**
 * Problem:
 * Cancelling or interrupting an in-flight turn leaves uncommitted in-progress checkpoints (status=2)
 * in the session's SQLite database (`~/.gemini/antigravity-acp/conversations/<sessionId>.db`).
 * Resuming or executing subsequent prompts against the session triggers a fatal panic:
 * `"panic: could not find doneCh for checkpoint"`.
 *
 * Solution:
 * Inspects the session's SQLite database on load and shutdown, repairing any orphaned
 * in-progress checkpoints and action steps to ABORTED (status=5) with isolated session scoping.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ACP_METHODS,
  type AcpStreamMessage,
  type AcpFix,
  type OutboundContext,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";
import { decodeVarint, getField } from "../../lib/protobuf.js";

export const STEP_TYPE_USER = 14;
export const STEP_TYPE_AGENT = 15;
export const STEP_TYPE_ERROR = 17;
export const STEP_TYPE_CHECKPOINT = 23;

export const CHECKPOINT_STATUS_IN_PROGRESS = 2;
export const CHECKPOINT_STATUS_ABORTED = 5;

export const DONE_CH_PANIC_MARKER = "could not find doneCh for checkpoint";

export function getConversationDbPath(sessionId: string): string {
  const geminiHome = process.env.GEMINI_HOME || join(homedir(), ".gemini");
  return join(geminiHome, "antigravity-acp", "conversations", `${sessionId}.db`);
}

export function extractExecutorMetadataStepIdx(data: Uint8Array): number | null {
  let offset = 0;
  while (offset < data.length) {
    const [tag, nextOffset] = decodeVarint(data, offset);
    const fieldNum = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const [v, after] = decodeVarint(data, nextOffset);
      if (fieldNum === 3) return v;
      offset = after;
    } else if (wireType === 2) {
      const [len, afterLen] = decodeVarint(data, nextOffset);
      offset = afterLen + len;
    } else if (wireType === 1) {
      offset = nextOffset + 8;
    } else if (wireType === 5) {
      offset = nextOffset + 4;
    } else {
      break;
    }
  }
  return null;
}

export function extractGenMetadataStepIndices(data: Uint8Array): {
  stepIdx: number | null;
  earliestIdx: number | null;
} {
  let stepIdx: number | null = null;
  let earliestIdx: number | null = null;

  const f2 = getField(data, 2);
  if (f2 && f2.length >= 1) {
    let offset = 0;
    while (offset < f2.length) {
      const [v, next] = decodeVarint(f2, offset);
      if (stepIdx === null || v > stepIdx) {
        stepIdx = v;
      }
      offset = next;
    }
  }

  const f1 = getField(data, 1);
  if (f1) {
    const f9 = getField(f1, 9);
    if (f9 && f9.length >= 2) {
      const [tag, off] = decodeVarint(f9, 0);
      if (tag >> 3 === 1) {
        const [val] = decodeVarint(f9, off);
        earliestIdx = val;
      }
    }
  }

  return { stepIdx, earliestIdx };
}

function repairStepCheckpoints(db: DatabaseSync): number {
  const stmt = db.prepare(`
    UPDATE steps
    SET status = ${CHECKPOINT_STATUS_ABORTED},
        step_payload = CASE
          WHEN length(step_payload) >= 4 AND substr(step_payload, 3, 2) = x'2002'
          THEN CAST(substr(step_payload, 1, 3) || x'05' || substr(step_payload, 5) AS BLOB)
          ELSE step_payload
        END
    WHERE status = ${CHECKPOINT_STATUS_IN_PROGRESS} OR (length(step_payload) >= 4 AND substr(step_payload, 3, 2) = x'2002');
  `);
  return Number(stmt.run().changes);
}

function pruneExecutorMetadata(db: DatabaseSync, maxStepIdx: number): number {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'executor_metadata'")
    .get();
  if (!hasTable) return 0;

  let pruned = 0;
  const rows = db
    .prepare("SELECT idx, data FROM executor_metadata ORDER BY idx DESC")
    .all() as Array<{ idx: number; data: Uint8Array | null }>;
  for (const row of rows) {
    if (!row.data) continue;
    const step = extractExecutorMetadataStepIdx(row.data);
    if (step !== null && step > maxStepIdx) {
      db.prepare("DELETE FROM executor_metadata WHERE idx = ?").run(row.idx);
      pruned++;
    }
  }
  return pruned;
}

function pruneGenMetadata(db: DatabaseSync, maxStepIdx: number): number {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata'")
    .get();
  if (!hasTable) return 0;

  let pruned = 0;
  const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx DESC").all() as Array<{
    idx: number;
    data: Uint8Array | null;
  }>;
  for (const row of rows) {
    if (!row.data) continue;
    const { stepIdx, earliestIdx } = extractGenMetadataStepIndices(row.data);
    if (
      (stepIdx !== null && stepIdx > maxStepIdx) ||
      (earliestIdx !== null && earliestIdx > maxStepIdx)
    ) {
      db.prepare("DELETE FROM gen_metadata WHERE idx = ?").run(row.idx);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Automatically repairs orphaned in-progress steps (status=2), including checkpoints
 * (step_type=23) and action/tool steps (step_type=21), left behind by cancelled, aborted,
 * or interrupted Antigravity turns. Setting status=5 (aborted) prevents Antigravity
 * from crashing on resumption or next prompt with "could not find doneCh for checkpoint".
 *
 * Also prunes orphaned or out-of-bounds `executor_metadata` and `gen_metadata` entries
 * whose step indices exceed the maximum valid step in `steps`, preventing fatal Go executor
 * panics ("earliest step index is out of bounds: X vs Y").
 *
 * Returns the number of repaired steps and metadata records.
 */
export function repairOrphanedCheckpoints(sessionId: string, customDbPath?: string): number {
  const dbPath = customDbPath ?? getConversationDbPath(sessionId);
  if (!existsSync(dbPath)) return 0;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { timeout: 2000 });
    let repairedCount = repairStepCheckpoints(db);

    const maxRow = db
      .prepare(`SELECT max(idx) as m FROM steps WHERE step_type != ${STEP_TYPE_ERROR}`)
      .get() as { m: number | null } | undefined;
    const maxStepIdx = maxRow?.m ?? null;

    if (maxStepIdx !== null) {
      const cleanErrorSteps = db
        .prepare(`DELETE FROM steps WHERE idx > ? AND step_type = ${STEP_TYPE_ERROR}`)
        .run(maxStepIdx);
      repairedCount += Number(cleanErrorSteps.changes);
      repairedCount += pruneExecutorMetadata(db, maxStepIdx);
      repairedCount += pruneGenMetadata(db, maxStepIdx);
    }

    if (repairedCount > 0) {
      console.error(
        `[refined-antigravity-acp] Repaired ${repairedCount} orphaned checkpoint/step/metadata record(s) for session ${sessionId}`,
      );
    }
    return repairedCount;
  } catch (err) {
    console.error(
      `[refined-antigravity-acp] Failed to repair checkpoints for session ${sessionId}:`,
      err,
    );
    return 0;
  } finally {
    db?.close();
  }
}

export const orphanedCheckpointsFix: AcpFix = {
  name: "orphaned-checkpoints",
  description:
    "Repairs orphaned in-progress SQLite checkpoints to prevent fatal doneCh panics on resumption",

  async onRecycle(session): Promise<void> {
    if (session?.sessionId) {
      repairOrphanedCheckpoints(session.sessionId);
    }
  },

  onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
    if (
      "method" in msg &&
      (msg.method === ACP_METHODS.SESSION_LOAD || msg.method === ACP_METHODS.SESSION_PROMPT)
    ) {
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        repairOrphanedCheckpoints(sessionId);
      }
    }
    return msg;
  },
};

export const checkpointRepairFix = orphanedCheckpointsFix;
