/**
 * Problem:
 * Upstream `agy_acp_server` (1.3.0) only offers non-Gemini models (Claude, GPT-OSS) when the
 * `clientInfo.name` sent in ACP `initialize` identifies Zed, Xcode or JetBrains. Every other
 * client (Paseo, Neovim, custom ACP clients) sees Gemini models only, and selecting a non-Gemini
 * model id fails with `-32602 Model '<id>' is not available for the current authentication method`.
 * The gate is a deliberate client-name check upstream, not a quota or entitlement check.
 *
 * Solution:
 * Opt-in only. When `REFINED_AGY_CLIENT_NAME` is set, rewrites `clientInfo.name` in the outbound
 * `initialize` request (including the one re-sent after a process recycle) to that value, keeping
 * the rest of `clientInfo`. When the variable is unset or empty, `initialize` passes through
 * unchanged.
 */

import { ACP_METHODS, type AcpFix, type AcpStreamMessage } from "../../core/types.js";

export const CLIENT_NAME_ENV = "REFINED_AGY_CLIENT_NAME";

const FALLBACK_CLIENT_VERSION = "0.0.0";

/** Returns the configured client name override, or undefined when the override is disabled. */
export function resolveClientNameOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[CLIENT_NAME_ENV]?.trim() || undefined;
}

/**
 * Returns a copy of an `initialize` request with `clientInfo.name` replaced by `name`.
 * Other messages, and `initialize` requests that already carry `name`, are returned as is.
 */
export function overrideClientName(msg: AcpStreamMessage, name: string): AcpStreamMessage {
  if (!("method" in msg) || msg.method !== ACP_METHODS.INITIALIZE) return msg;

  const params =
    msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};
  const clientInfo =
    params.clientInfo && typeof params.clientInfo === "object"
      ? (params.clientInfo as Record<string, unknown>)
      : undefined;
  if (clientInfo?.name === name) return msg;

  return {
    ...msg,
    params: {
      ...params,
      clientInfo: {
        version: FALLBACK_CLIENT_VERSION,
        ...clientInfo,
        name,
      },
    },
  } as AcpStreamMessage;
}

export const gatedThirdPartyModelsFix: AcpFix = {
  name: "gated-third-party-models",
  description: `Overrides clientInfo.name in initialize when ${CLIENT_NAME_ENV} is set`,

  onOutbound(msg: AcpStreamMessage): AcpStreamMessage {
    const name = resolveClientNameOverride();
    return name ? overrideClientName(msg, name) : msg;
  },
};
