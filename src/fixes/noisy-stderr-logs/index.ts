/**
 * Problem:
 * Upstream `agy_acp_server` logs every raw WebSocket frame (including megabytes of tool outputs)
 * directly to stderr with `"RAW WS MSG:"`, flooding editor log buffers and stalling event loops.
 *
 * Solution:
 * Intercepts stderr lines and filters out raw websocket trace lines by default, exposing them
 * only when `REFINED_AGY_TRACE=1` is explicitly enabled.
 */

import type { AcpFix, StderrContext } from "../../core/types.js";
import { RAW_WS_MSG_MARKER } from "../../core/telemetry.js";

export { RAW_WS_MSG_MARKER };

export const noisyStderrLogsFix: AcpFix = {
  name: "noisy-stderr-logs",
  description: "Filters verbose websocket trace payloads from stderr unless REFINED_AGY_TRACE=1",

  onStderrLine(line: string, _context: StderrContext): boolean {
    if (!line.includes(RAW_WS_MSG_MARKER)) {
      return false;
    }
    return process.env.REFINED_AGY_TRACE !== "1";
  },
};

export const stderrFilteringFix = noisyStderrLogsFix;
