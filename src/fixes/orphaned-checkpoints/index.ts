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

export const STEP_TYPE_USER = 14;
export const STEP_TYPE_AGENT = 15;
export const STEP_TYPE_CHECKPOINT = 23;

export const CHECKPOINT_STATUS_IN_PROGRESS = 2;
export const CHECKPOINT_STATUS_ABORTED = 5;

export const DONE_CH_PANIC_MARKER = "could not find doneCh for checkpoint";

export function getConversationDbPath(sessionId: string): string {
  const geminiHome = process.env.GEMINI_HOME || join(homedir(), ".gemini");
  return join(geminiHome, "antigravity-acp", "conversations", `${sessionId}.db`);
}

/**
 * Automatically repairs orphaned in-progress steps (status=2), including checkpoints
 * (step_type=23) and action/tool steps (step_type=21), left behind by cancelled, aborted,
 * or interrupted Antigravity turns. Setting status=5 (aborted) prevents Antigravity
 * from crashing on resumption or next prompt with "could not find doneCh for checkpoint".
 *
 * Returns the number of repaired steps.
 */
export function repairOrphanedCheckpoints(sessionId: string, customDbPath?: string): number {
  const dbPath = customDbPath ?? getConversationDbPath(sessionId);
  if (!existsSync(dbPath)) return 0;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { timeout: 2000 });
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
    const result = stmt.run();
    const repairedCount = Number(result.changes);

    if (repairedCount > 0) {
      console.error(
        `[refined-antigravity-acp] Repaired ${repairedCount} orphaned checkpoint/step(s) for session ${sessionId}`,
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

  onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
    if ("method" in msg && msg.method === ACP_METHODS.SESSION_LOAD) {
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        repairOrphanedCheckpoints(sessionId);
      }
    }
    return msg;
  },
};

export const checkpointRepairFix = orphanedCheckpointsFix;
