/**
 * Problem:
 * When upstream Antigravity executes tool calls (or receives a prompt) and halts with an empty
 * completion (stopReason=16, no text and no tool call), upstream completes the prompt turn
 * with a successful result without emitting any `agent_message_chunk`. Editor clients (Paseo, Zed)
 * transition the session to idle, leaving the user with zero explanation and an apparent hang.
 *
 * Solution:
 * Injects explicit system prompt steering instructing the model to never end a prompt turn without
 * emitting a clear assistant text message, eliminating premature silent stops at the model source
 * without synthesizing synthetic conversational prose in the proxy.
 */

import type { AcpFix } from "../../core/types.js";

export function createPrematureTurnStopFix(): AcpFix {
  return {
    name: "premature-turn-stop",
    description: "Steers model to prevent premature empty turn stops without assistant messages",

    getSystemInstructions(): readonly string[] {
      return [
        "Never end a prompt turn without emitting a clear assistant text message summarizing completed actions, current status, or next steps.",
        "When executing commit commands, linter checks, or tests that encounter errors, explicitly explain the failures to the user before attempting further autonomous repairs.",
      ];
    },
  };
}

export const prematureTurnStopFix = createPrematureTurnStopFix();
