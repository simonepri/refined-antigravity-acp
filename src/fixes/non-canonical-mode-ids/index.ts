/**
 * Problem:
 * Standard ACP clients (like Paseo) send canonical mode identifiers such as `accept-edits`,
 * `dangerously-skip-permissions`, and `plan`. Upstream `agy_acp_server` strictly expects internal
 * strings (`auto_edit`, `yolo`, `default`), failing with an RPC error on unknown mode IDs.
 *
 * Solution:
 * Maps standard client mode aliases to canonical internal IDs across all outbound
 * session requests (`session/new`, `session/load`, `session/set_mode`).
 */

import type { AcpFix, AcpStreamMessage } from "../../core/types.js";

export const MODE_MAPPINGS: Readonly<Record<string, string>> = {
  "accept-edits": "auto_edit",
  "dangerously-skip-permissions": "yolo",
  plan: "default",
};

/**
 * Normalizes client mode IDs to Antigravity internal mode IDs:
 * - "accept-edits" -> "auto_edit"
 * - "dangerously-skip-permissions" -> "yolo"
 * - "plan" -> "default"
 */
export function normalizeModeId(modeId?: string): string | undefined {
  if (!modeId) return modeId;
  return MODE_MAPPINGS[modeId] ?? modeId;
}

/**
 * In-place mutation of modeId in message params if present.
 */
export function normalizeModeIdOnMsg(msg: AcpStreamMessage): void {
  if ("params" in msg && msg.params && typeof msg.params === "object" && "modeId" in msg.params) {
    const p = msg.params as { modeId?: string | undefined };
    if (typeof p.modeId === "string") {
      p.modeId = normalizeModeId(p.modeId);
    }
  }
}

export const nonCanonicalModeIdsFix: AcpFix = {
  name: "non-canonical-mode-ids",
  description:
    "Translates standard client mode identifiers (accept-edits, plan) to internal engine IDs",

  onOutbound(msg: AcpStreamMessage): AcpStreamMessage {
    normalizeModeIdOnMsg(msg);
    return msg;
  },
};

export const modeNormalizationFix = nonCanonicalModeIdsFix;
