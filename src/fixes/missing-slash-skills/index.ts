/**
 * Problem:
 * Upstream `agy_acp_server` only advertises built-in model commands and ignores custom
 * workspace slash skills defined in standard project directories (e.g. `.agents/skills`, `.gemini/skills`).
 *
 * Solution:
 * Recursively discovers `SKILL.md` skill definitions across all configured workspace directories,
 * injects the skills catalog into active prompts, and dynamically augments `available_commands_update`.
 */

import {
  ACP_METHODS,
  SESSION_UPDATES,
  isMethod,
  isJsonRpcSuccessResponse,
  type AcpStreamMessage,
  type AcpFix,
  type InboundContext,
  type OutboundContext,
  type SessionAllocationResult,
  type SessionPromptParams,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";
import { extractSessionId, getSession, getOrCreateSession } from "../../core/session-cache.js";
import {
  type AvailableCommand,
  type DiscoveredSkill,
  BUILTIN_COMMANDS,
  parseSkillFile,
  resolveSkillRoots,
  discoverSkills,
  augmentCommands,
  formatSkillsCatalog,
} from "./skills.js";

export {
  BUILTIN_COMMANDS,
  parseSkillFile,
  resolveSkillRoots,
  discoverSkills,
  augmentCommands,
  formatSkillsCatalog,
};
export type { AvailableCommand, DiscoveredSkill };

function availableCommandsUpdateOf(
  msg: AcpStreamMessage,
): { sessionId?: string; update: SessionUpdatePayload } | null {
  if (!isMethod(msg, ACP_METHODS.SESSION_UPDATE)) return null;
  const params = msg.params as SessionUpdateParams | undefined;
  const update = params?.update;
  if (!update || typeof update !== "object") return null;
  if (update.sessionUpdate !== SESSION_UPDATES.AVAILABLE_COMMANDS_UPDATE) return null;
  return { sessionId: params?.sessionId, update };
}

function augmentAvailableCommandsUpdate(msg: AcpStreamMessage, context: InboundContext): void {
  const found = availableCommandsUpdateOf(msg);
  if (!found) return;
  const cwd = getSession(context.sessionCache, found.sessionId)?.cwd;
  const existing = Array.isArray(found.update.availableCommands)
    ? (found.update.availableCommands as AvailableCommand[])
    : undefined;
  found.update.availableCommands = augmentCommands(existing, cwd);
}

function initialAvailableCommandsOf(
  msg: AcpStreamMessage,
  context: InboundContext,
): AcpStreamMessage | null {
  if (!isJsonRpcSuccessResponse<SessionAllocationResult>(msg)) return null;
  const sessionId = typeof msg.result?.sessionId === "string" ? msg.result.sessionId : undefined;
  if (!sessionId) return null;
  const cwd = getSession(context.sessionCache, sessionId)?.cwd;
  const commands = augmentCommands(undefined, cwd);
  if (commands.length === 0) return null;
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.AVAILABLE_COMMANDS_UPDATE,
        availableCommands: commands,
      },
    },
  };
}

export function injectSkillsCatalog(prompt: unknown, cwd?: string): void {
  if (!Array.isArray(prompt)) return;
  const skills = discoverSkills(cwd);
  const catalog = formatSkillsCatalog(skills);
  if (!catalog) return;

  const firstChunk = prompt[0] as { type?: string; text?: string } | undefined;
  if (firstChunk && firstChunk.type === "text" && typeof firstChunk.text === "string") {
    firstChunk.text = `${catalog}\n\n${firstChunk.text}`;
  } else {
    prompt.unshift({
      type: "text",
      text: catalog,
    });
  }
}

function handleSessionPromptOutbound(msg: AcpStreamMessage, context: OutboundContext): void {
  const sessionId = extractSessionId(msg);
  if (!sessionId) return;

  const session = getOrCreateSession(context.sessionCache, sessionId);
  const hasInjected = session.fixData?.get("hasInjectedSkillsCatalog");
  if (!hasInjected) {
    const prompt =
      "params" in msg ? (msg.params as SessionPromptParams | undefined)?.prompt : undefined;
    injectSkillsCatalog(prompt, session.cwd);
    session.fixData ??= new Map();
    session.fixData.set("hasInjectedSkillsCatalog", true);
  }
}

export const missingSlashSkillsFix: AcpFix = {
  name: "missing-slash-skills",
  description:
    "Discovers workspace skills from SKILL.md files and augments ACP available_commands_update",

  onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
    if (isMethod(msg, ACP_METHODS.SESSION_PROMPT)) {
      handleSessionPromptOutbound(msg, context);
    }
    return msg;
  },

  onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
    if ("result" in msg && msg.result) {
      const initialCommands = initialAvailableCommandsOf(msg, context);
      return initialCommands ? [msg, initialCommands] : [msg];
    }

    augmentAvailableCommandsUpdate(msg, context);
    return [msg];
  },
};

export const slashSkillsFix = missingSlashSkillsFix;
