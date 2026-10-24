/**
 * Problem:
 * Upstream `agy_acp_server` exposes all native built-in tools by default (including
 * `generate_image`, `schedule`, `run_workflow`, etc.), injecting thousands of tokens
 * of unused JSON schema definitions and prompt instructions into every turn's context.
 *
 * Solution:
 * Disables native built-in tools when configured via `REFINED_AGY_DISABLED_TOOLS`
 * by injecting them into `_meta.antigravity.disabledTools` on session initialization.
 */

import {
  ACP_METHODS,
  isMethod,
  type AcpFix,
  type AcpStreamMessage,
  type OutboundContext,
} from "../../core/types.js";

function getDisabledToolsFromEnv(): string[] | null {
  const envVal = process.env.REFINED_AGY_DISABLED_TOOLS?.trim();
  if (!envVal || envVal === "none" || envVal === "0" || envVal === "false") {
    return null;
  }

  const tools = envVal
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return tools.length > 0 ? tools : null;
}

export const prunedBuiltinToolsFix: AcpFix = {
  name: "pruned-builtin-tools",
  description: "Disables native built-in tools configured via REFINED_AGY_DISABLED_TOOLS",

  onOutbound(msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage {
    const disabledTools = getDisabledToolsFromEnv();
    if (!disabledTools) return msg;

    if (
      !isMethod(msg, ACP_METHODS.SESSION_NEW) &&
      !isMethod(msg, ACP_METHODS.SESSION_LOAD) &&
      !isMethod(msg, ACP_METHODS.SESSION_RESUME)
    ) {
      return msg;
    }

    const params = (msg.params ??= {}) as Record<string, unknown>;
    const meta = (params._meta ??= {}) as Record<string, unknown>;
    const agy = (meta.antigravity ??= {}) as Record<string, unknown>;

    const existing = Array.isArray(agy.disabledTools) ? (agy.disabledTools as string[]) : [];

    agy.disabledTools = Array.from(new Set([...existing, ...disabledTools]));

    return msg;
  },
};
