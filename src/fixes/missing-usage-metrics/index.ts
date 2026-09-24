/**
 * Problem:
 * Upstream `agy_acp_server` never emits ACP `session/update` notifications with `sessionUpdate: "usage_update"`,
 * leaving editor context window usage meters blank and providing no visibility into token consumption.
 *
 * Solution:
 * Reads token metadata directly from the session's SQLite database upon prompt turn completion,
 * synthesizing standard ACP `session/update` usage updates with `used` and `size` metrics.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  isJsonRpcRequest,
  type AcpFix,
  type AcpStreamMessage,
  type InboundContext,
  type OutboundContext,
} from "../../core/types.js";

import { extractSessionId } from "../../core/session-cache.js";
import { getConversationDbPath, STEP_TYPE_AGENT } from "../orphaned-checkpoints/index.js";
import { getField, getVarintField } from "../../lib/protobuf.js";

export { getVarintField };

export interface TokenUsage {
  usedTokens: number;
  maxTokens: number;
  promptTokens: number;
  candidateTokens: number;
}

export function extractUsageFromMetadata(metadata: Uint8Array): TokenUsage | null {
  const f9 = getField(metadata, 9);
  if (!f9) return null;

  const promptTokens = getVarintField(f9, 2) ?? 0;
  const candidateTokens = getVarintField(f9, 3) ?? 0;

  const maxTokens = getVarintField(getField(metadata, 24), 4) ?? 1_000_000;
  const usedTokens = promptTokens + candidateTokens;

  return {
    usedTokens,
    maxTokens,
    promptTokens,
    candidateTokens,
  };
}

export function getLatestSessionUsage(sessionId: string, customDbPath?: string): TokenUsage | null {
  const dbPath = customDbPath ?? getConversationDbPath(sessionId);
  if (!existsSync(dbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { timeout: 2000, readOnly: true });
    const row = db
      .prepare(
        `SELECT metadata FROM steps WHERE step_type = ${STEP_TYPE_AGENT} AND metadata IS NOT NULL ORDER BY idx DESC LIMIT 1;`,
      )
      .get() as { metadata: Uint8Array | null } | undefined;
    if (!row?.metadata) return null;
    return extractUsageFromMetadata(row.metadata);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function createUsageUpdateMessage(sessionId: string, usage: TokenUsage): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.USAGE_UPDATE,
        used: usage.usedTokens,
        size: usage.maxTokens,
      },
    },
  };
}

function attachUsageToResult(msg: AcpStreamMessage, usage: TokenUsage): AcpStreamMessage {
  if (!("result" in msg) || !msg.result || typeof msg.result !== "object") return msg;
  const resultObj = msg.result as Record<string, unknown>;
  return {
    ...msg,
    result: {
      ...resultObj,
      usage: {
        totalTokens: usage.usedTokens,
        inputTokens: usage.promptTokens,
        outputTokens: usage.candidateTokens,
        contextWindowMaxTokens: usage.maxTokens,
        contextWindowUsedTokens: usage.usedTokens,
      },
    },
  };
}

const MAX_PENDING_PROMPTS = 500;

export function createMissingUsageMetricsFix(
  customDbPathGetter?: (sessionId: string) => string,
): AcpFix {
  const pendingPromptSessions = new Map<string | number, string>();

  return {
    name: "missing-usage-metrics",
    description:
      "Extracts token counts from SQLite step metadata and synthesizes standard ACP usage_update notifications",

    onOutbound: (msg: AcpStreamMessage, _context: OutboundContext): AcpStreamMessage => {
      if (
        isJsonRpcRequest(msg) &&
        (msg.method === ACP_METHODS.SESSION_PROMPT || msg.method === ACP_METHODS.SESSION_LOAD)
      ) {
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          if (pendingPromptSessions.size >= MAX_PENDING_PROMPTS) {
            const oldest = pendingPromptSessions.keys().next().value;
            if (oldest !== undefined) pendingPromptSessions.delete(oldest);
          }
          pendingPromptSessions.set(msg.id, sessionId);
        }
      }
      return msg;
    },

    onInbound: async (
      msg: AcpStreamMessage,
      context: InboundContext,
    ): Promise<AcpStreamMessage[]> => {
      if (!("id" in msg) || msg.id === null || msg.id === undefined) return [msg];
      if (!pendingPromptSessions.has(msg.id)) return [msg];

      const sessionId = context.session?.sessionId ?? pendingPromptSessions.get(msg.id);
      pendingPromptSessions.delete(msg.id);
      if (!sessionId) return [msg];

      const dbPath = customDbPathGetter ? customDbPathGetter(sessionId) : undefined;
      const usage = getLatestSessionUsage(sessionId, dbPath);
      if (!usage) return [msg];

      return [createUsageUpdateMessage(sessionId, usage), attachUsageToResult(msg, usage)];
    },

    onRecycle: (): void => {
      pendingPromptSessions.clear();
    },

    dispose: (): void => {
      pendingPromptSessions.clear();
    },
  };
}

export const missingUsageMetricsFix = createMissingUsageMetricsFix();
export const createUsageMetricsFix = createMissingUsageMetricsFix;
export const usageMetricsFix = missingUsageMetricsFix;
