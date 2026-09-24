/**
 * Problem:
 * Upstream `agy_acp_server` encodes reasoning effort directly into model identifiers
 * (e.g. `gemini-3.8-flash-high`, `gemini-3.8-flash-low`), presenting a confusing flat list
 * of model variants and providing no dedicated reasoning effort control.
 *
 * Solution:
 * Collapses duplicate model entries into clean base models, injects a dedicated
 * `thought_level` option (`high`, `medium`, `low`), and dynamically reconstructs the upstream
 * composite model identifier on selection.
 */

import {
  ACP_METHODS,
  type AcpFix,
  type AcpStreamMessage,
  type CachedSessionMetadata,
  type InboundContext,
  type OutboundContext,
  type SessionCache,
} from "../../core/types.js";
import {
  extractSessionId,
  getFixData,
  getOrCreateFixData,
  getOrCreateSession,
  setFixData,
} from "../../core/session-cache.js";

export type ReasoningEffortLevel = "high" | "medium" | "low";
export const EFFORT_OPTION_ID = "thought_level";

const EFFORT_SUFFIX_RE = /-(high|medium|low)$/i;
const EFFORT_NAME_RE =
  /\s*(?:\((high|medium|low)\)|\[(high|medium|low)\]|-\s*(high|medium|low))\s*$/i;
const EFFORT_CONFIG_IDS = new Set([
  EFFORT_OPTION_ID,
  "effort",
  "reasoning_effort",
  "thinking_effort",
]);

export interface ParsedModelEffort {
  baseModelId: string;
  baseModelName: string;
  effort: ReasoningEffortLevel;
  rawId: string;
}

export function normalizeEffort(effort?: string): ReasoningEffortLevel {
  const lower = effort?.toLowerCase();
  return lower === "low" || lower === "medium" ? lower : "high";
}

export function cleanEffortFromName(name?: string): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(EFFORT_NAME_RE, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function formatModelIdToName(baseId: string): string {
  if (!baseId) return "";
  return baseId
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^\d+(\.\d+)*$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function parseEffort(
  idMatch: RegExpMatchArray | null,
  nameMatch?: RegExpMatchArray | null,
): ReasoningEffortLevel {
  return normalizeEffort(
    idMatch?.[1] || nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3] || "high",
  );
}

export function parseModelAndEffort(rawId: unknown, rawName?: unknown): ParsedModelEffort {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const name = typeof rawName === "string" ? rawName.trim() : undefined;

  if (id === "gemini-pro-agent") {
    return {
      baseModelId: "gemini-3.1-pro",
      baseModelName: "Gemini 3.1 Pro",
      effort: "high",
      rawId: id,
    };
  }

  const idMatch = id.match(EFFORT_SUFFIX_RE);
  const nameMatch = name?.match(EFFORT_NAME_RE);
  const effort = parseEffort(idMatch, nameMatch);
  const baseId = idMatch ? id.slice(0, -idMatch[0].length) : id;
  const baseModelName = cleanEffortFromName(name) || formatModelIdToName(baseId) || baseId;

  return { baseModelId: baseId, baseModelName, effort, rawId: id };
}

function resolveKnownModel(base: string, effort: ReasoningEffortLevel): string | undefined {
  if (base === "gemini-3.1-pro" || base === "gemini-pro-agent") {
    return effort === "low" ? "gemini-3.1-pro-low" : "gemini-pro-agent";
  }
  return undefined;
}

export const SELECTED_BASE_MODEL_KEY = "selectedBaseModel";
export const SELECTED_EFFORT_KEY = "selectedEffort";
export const MODEL_VARIANTS_KEY = "modelVariants";
export const KNOWN_THINKING_MODELS_KEY = "knownThinkingModels";

export function getSelectedBaseModel(session: CachedSessionMetadata): string | undefined {
  return getFixData<string>(session, SELECTED_BASE_MODEL_KEY);
}

export function setSelectedBaseModel(session: CachedSessionMetadata, model: string): void {
  setFixData(session, SELECTED_BASE_MODEL_KEY, model);
}

export function getSelectedEffort(session: CachedSessionMetadata): string | undefined {
  return getFixData<string>(session, SELECTED_EFFORT_KEY);
}

export function setSelectedEffort(session: CachedSessionMetadata, effort: string): void {
  setFixData(session, SELECTED_EFFORT_KEY, effort);
}

export function getModelVariants(session?: CachedSessionMetadata): Map<string, string> | undefined {
  return getFixData<Map<string, string>>(session, MODEL_VARIANTS_KEY);
}

export function getKnownThinkingModels(session?: CachedSessionMetadata): Set<string> | undefined {
  return getFixData<Set<string>>(session, KNOWN_THINKING_MODELS_KEY);
}

export function composeModelId(
  baseModelId: string,
  effort?: string,
  session?: CachedSessionMetadata,
): string {
  if (!effort) return baseModelId;
  const e = normalizeEffort(effort);
  const cleanBase = baseModelId
    .replace(/^gemini-3\.1-pro-low$/, "gemini-3.1-pro")
    .replace(EFFORT_SUFFIX_RE, "");

  const variant = getModelVariants(session)?.get(`${cleanBase}:${e}`);
  if (variant) return variant;

  const known = resolveKnownModel(cleanBase, e);
  if (known) return known;

  const isThinking =
    cleanBase.startsWith("gemini-") || Boolean(getKnownThinkingModels(session)?.has(cleanBase));
  return isThinking ? `${cleanBase}-${e}` : baseModelId;
}

function recordSessionVariant(
  session: CachedSessionMetadata | undefined,
  parsed: ParsedModelEffort,
  rawId: string,
): void {
  if (!session) return;
  const variants = getOrCreateFixData(session, MODEL_VARIANTS_KEY, () => new Map<string, string>());
  const knownThinking = getOrCreateFixData(
    session,
    KNOWN_THINKING_MODELS_KEY,
    () => new Set<string>(),
  );
  variants.set(`${parsed.baseModelId}:${parsed.effort}`, rawId);
  if (parsed.baseModelId !== rawId) {
    knownThinking.add(parsed.baseModelId);
  }
}

function collapseList(
  items: unknown[],
  idKey: "modelId" | "value",
  session?: CachedSessionMetadata,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const collapsed: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const rawId = typeof raw[idKey] === "string" ? (raw[idKey] as string) : "";
    if (!rawId) continue;

    const parsed = parseModelAndEffort(rawId, raw.name);
    if (!parsed.baseModelId) continue;

    recordSessionVariant(session, parsed, rawId);
    if (!seen.has(parsed.baseModelId)) {
      seen.add(parsed.baseModelId);
      collapsed.push({ [idKey]: parsed.baseModelId, name: parsed.baseModelName });
    }
  }
  return collapsed;
}

function setSessionModel(
  session: CachedSessionMetadata | undefined,
  base: string,
  effort: ReasoningEffortLevel,
): void {
  if (!session) return;
  setSelectedBaseModel(session, base);
  setSelectedEffort(session, effort);
}

function collapseModels(
  models: { availableModels?: unknown[]; currentModelId?: unknown } | undefined,
  session?: CachedSessionMetadata,
): { hasBase: boolean; effort?: ReasoningEffortLevel | undefined } {
  let hasBase = false;
  let effort: ReasoningEffortLevel | undefined;
  if (Array.isArray(models?.availableModels) && models.availableModels.length > 0) {
    const collapsed = collapseList(models.availableModels, "modelId", session);
    if (collapsed.length > 0) {
      models.availableModels = collapsed;
      hasBase = true;
    }
  }
  if (typeof models?.currentModelId === "string") {
    const p = parseModelAndEffort(models.currentModelId);
    models.currentModelId = p.baseModelId;
    effort = p.effort;
    setSessionModel(session, p.baseModelId, p.effort);
  }
  return { hasBase, effort };
}

function collapseModelOption(
  opt: Record<string, unknown>,
  session?: CachedSessionMetadata,
): { hasBase: boolean; effort?: ReasoningEffortLevel | undefined } {
  let hasBase = false;
  let effort: ReasoningEffortLevel | undefined;
  if (Array.isArray(opt.options) && opt.options.length > 0) {
    const collapsed = collapseList(opt.options, "value", session);
    if (collapsed.length > 0) {
      opt.options = collapsed;
      hasBase = true;
    }
  }
  if (typeof opt.currentValue === "string") {
    const p = parseModelAndEffort(opt.currentValue);
    opt.currentValue = p.baseModelId;
    effort = p.effort;
    setSessionModel(session, p.baseModelId, p.effort);
  }
  return { hasBase, effort };
}

function injectEffort(
  options: Array<Record<string, unknown>>,
  index: number,
  effort: ReasoningEffortLevel,
): void {
  const exists = options.some(
    (o) => o?.id === EFFORT_OPTION_ID || o?.category === EFFORT_OPTION_ID,
  );
  if (exists) return;
  options.splice(index + 1, 0, {
    id: EFFORT_OPTION_ID,
    name: "Reasoning Effort",
    category: EFFORT_OPTION_ID,
    type: "select",
    currentValue: effort,
    options: [
      { value: "high", name: "High" },
      { value: "medium", name: "Medium" },
      { value: "low", name: "Low" },
    ],
  });
}

function resolveTargetSession(
  sId: unknown,
  fallbackId?: string,
  cache?: SessionCache,
): CachedSessionMetadata | undefined {
  const id = typeof sId === "string" ? sId : fallbackId;
  return id && cache ? getOrCreateSession(cache, id) : undefined;
}

export function filterConfigOptions(
  payload: unknown,
  cache?: SessionCache,
  fallbackSessionId?: string,
): void {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as {
    sessionId?: unknown;
    models?: { availableModels?: unknown[]; currentModelId?: unknown };
    configOptions?: Array<Record<string, unknown>>;
  };
  const session = resolveTargetSession(obj.sessionId, fallbackSessionId, cache);
  const modelsResult = collapseModels(obj.models, session);
  if (!Array.isArray(obj.configOptions)) return;

  obj.configOptions = obj.configOptions.filter(
    (opt) => opt?.id !== "mode" && opt?.category !== "mode",
  );
  const modelIdx = obj.configOptions.findIndex(
    (opt) => opt?.id === "model" && opt?.category === "model",
  );
  const targetOpt = obj.configOptions[modelIdx];
  if (!targetOpt) return;

  const optResult = collapseModelOption(targetOpt, session);
  if (modelsResult.hasBase || optResult.hasBase) {
    const effort = optResult.effort ?? modelsResult.effort ?? "high";
    injectEffort(obj.configOptions, modelIdx, effort);
  }
}

function handleSetModel(
  params: { sessionId?: string; modelId?: string },
  session: CachedSessionMetadata,
): void {
  if (typeof params.modelId !== "string") return;
  const p = parseModelAndEffort(params.modelId);
  setSelectedBaseModel(session, p.baseModelId);
  if (p.baseModelId !== params.modelId) setSelectedEffort(session, p.effort);
  const effort = getSelectedEffort(session) ?? "high";
  const composite = composeModelId(p.baseModelId, effort, session);
  params.modelId = composite;
  session.lastConfigOptions.set("model", { value: composite, type: "select" });
}

function handleModelConfig(
  params: { configId?: string; value?: unknown; type?: unknown },
  session: CachedSessionMetadata,
  val: string,
): void {
  const p = parseModelAndEffort(val);
  const knownThinking = getKnownThinkingModels(session);
  const isDecomposable =
    p.baseModelId !== val ||
    Boolean(knownThinking?.has(p.baseModelId)) ||
    val.startsWith("gemini-");
  if (!isDecomposable) {
    setSelectedBaseModel(session, val);
    session.lastConfigOptions.set("model", {
      value: val,
      type: typeof params.type === "string" ? params.type : undefined,
    });
    return;
  }
  setSelectedBaseModel(session, p.baseModelId);
  if (p.baseModelId !== val) setSelectedEffort(session, p.effort);
  const effort = getSelectedEffort(session) ?? "high";
  const composite = composeModelId(p.baseModelId, effort, session);
  params.value = composite;
  session.lastConfigOptions.set("model", {
    value: composite,
    type: typeof params.type === "string" ? params.type : "select",
  });
}

function handleSetConfig(
  params: { sessionId?: string; configId?: string; value?: unknown; type?: unknown },
  session: CachedSessionMetadata,
): void {
  if (typeof params.configId !== "string") return;
  const val = String(params.value ?? "");
  const selectedBaseModel = getSelectedBaseModel(session);
  if (params.configId === "model") {
    handleModelConfig(params, session, val);
  } else if (EFFORT_CONFIG_IDS.has(params.configId) && selectedBaseModel) {
    const effort = normalizeEffort(val);
    setSelectedEffort(session, effort);
    const composite = composeModelId(selectedBaseModel, effort, session);
    params.configId = "model";
    params.value = composite;
    session.lastConfigOptions.set("model", { value: composite, type: "select" });
  }
}

export const flattenedModelEffortsFix: AcpFix = {
  name: "flattened-model-efforts",
  description:
    "Decomposes flattened model variants and injects orthogonal reasoning effort controls",

  onInbound(msg: AcpStreamMessage, context: InboundContext): AcpStreamMessage[] {
    if ("result" in msg && msg.result && typeof msg.result === "object") {
      const res = msg.result as { models?: unknown; configOptions?: unknown };
      if (res.models || res.configOptions) {
        filterConfigOptions(msg.result, context.sessionCache, context.session?.sessionId);
      }
    }
    return [msg];
  },

  onOutbound(msg: AcpStreamMessage, context: OutboundContext): AcpStreamMessage {
    if (!("method" in msg)) return msg;
    const sessionId = extractSessionId(msg);
    if (!sessionId) return msg;
    const session = getOrCreateSession(context.sessionCache, sessionId);
    const params = msg.params as
      | { modelId?: string; configId?: string; value?: unknown; type?: unknown }
      | undefined;
    if (!params) return msg;

    if (msg.method === ACP_METHODS.SESSION_SET_MODEL) {
      handleSetModel(params, session);
    } else if (msg.method === ACP_METHODS.SESSION_SET_CONFIG_OPTION) {
      handleSetConfig(params, session);
    }
    return msg;
  },
};

export const modelEffortFix = flattenedModelEffortsFix;
