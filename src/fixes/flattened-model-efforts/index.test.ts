import { describe, expect, it } from "vitest";
import {
  cleanEffortFromName,
  composeModelId,
  filterConfigOptions,
  flattenedModelEffortsFix,
  formatModelIdToName,
  normalizeEffort,
  parseModelAndEffort,
} from "./index.js";
import { createSessionCache, getOrCreateSession } from "../../core/session-cache.js";
import { ACP_METHODS, isJsonRpcRequest } from "../../core/types.js";
import { createMockContext } from "../../test-utils/index.js";

describe("flattened-model-efforts unit tests", () => {
  it("normalizes effort strings correctly", () => {
    expect(normalizeEffort("low")).toBe("low");
    expect(normalizeEffort("LOW")).toBe("low");
    expect(normalizeEffort("medium")).toBe("medium");
    expect(normalizeEffort("high")).toBe("high");
    expect(normalizeEffort("xhigh")).toBe("xhigh");
    expect(normalizeEffort("x-high")).toBe("xhigh");
    expect(normalizeEffort("extrahigh")).toBe("xhigh");
    expect(normalizeEffort("unknown")).toBe("high");
    expect(normalizeEffort(undefined)).toBe("high");
  });

  it("cleans effort suffixes from display names", () => {
    expect(cleanEffortFromName("Gemini 4 Hydrogen (xhigh)")).toBe("Gemini 4 Hydrogen");
    expect(cleanEffortFromName("Gemini 4 Argon (High)")).toBe("Gemini 4 Argon");
    expect(cleanEffortFromName("Gemini 3.8 Flash [Medium]")).toBe("Gemini 3.8 Flash");
    expect(cleanEffortFromName("Claude 3.7 Sonnet - Low")).toBe("Claude 3.7 Sonnet");
    expect(cleanEffortFromName("Gemini 4 Argon")).toBe("Gemini 4 Argon");
    expect(cleanEffortFromName(undefined)).toBeUndefined();
  });

  it("formats model IDs to readable names", () => {
    expect(formatModelIdToName("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(formatModelIdToName("claude-3-7-sonnet")).toBe("Claude 3 7 Sonnet");
    expect(formatModelIdToName("")).toBe("");
  });

  it("parses model IDs and extracts base model IDs and reasoning efforts", () => {
    expect(parseModelAndEffort("gemini-4-argon-high", "Gemini 4 Argon (High)")).toEqual({
      baseModelId: "gemini-4-argon",
      baseModelName: "Gemini 4 Argon",
      effort: "high",
      rawId: "gemini-4-argon-high",
    });

    expect(parseModelAndEffort("gemini-3.8-flash-low")).toEqual({
      baseModelId: "gemini-3.8-flash",
      baseModelName: "Gemini 3.8 Flash",
      effort: "low",
      rawId: "gemini-3.8-flash-low",
    });

    expect(parseModelAndEffort("gemini-pro-agent")).toEqual({
      baseModelId: "gemini-3.1-pro",
      baseModelName: "Gemini 3.1 Pro",
      effort: "high",
      rawId: "gemini-pro-agent",
    });

    expect(parseModelAndEffort("gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (xhigh)")).toEqual({
      baseModelId: "gemini-4-hydrogen",
      baseModelName: "Gemini 4 Hydrogen",
      effort: "xhigh",
      rawId: "gemini-4-hydrogen-xhigh",
    });

    expect(parseModelAndEffort("gemini-pro-orchestrator")).toEqual({
      baseModelId: "gemini-pro-orchestrator",
      baseModelName: "Gemini Pro Orchestrator",
      effort: "high",
      rawId: "gemini-pro-orchestrator",
    });

    expect(parseModelAndEffort("gemini-pro-orchestrator-neon")).toEqual({
      baseModelId: "gemini-pro-orchestrator-neon",
      baseModelName: "Gemini Pro Orchestrator Neon",
      effort: "high",
      rawId: "gemini-pro-orchestrator-neon",
    });
    expect(composeModelId("gemini-4-hydrogen", "xhigh")).toBe("gemini-4-hydrogen-xhigh");
    expect(composeModelId("gemini-pro-orchestrator", "high")).toBe("gemini-pro-orchestrator");
    expect(composeModelId("gemini-pro-orchestrator-neon", "low")).toBe(
      "gemini-pro-orchestrator-neon",
    );
  });

  it("collapses models.availableModels into unique base models", () => {
    const cache = createSessionCache();
    const payload = {
      sessionId: "session-1",
      models: {
        availableModels: [
          { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
          { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
          { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
          { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
        ],
        currentModelId: "gemini-3.8-flash-high",
      },
      configOptions: [
        {
          id: "thinking_level",
          name: "Thinking Level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    };

    filterConfigOptions(payload, cache, "session-1");

    expect(payload.models.availableModels).toEqual([
      { modelId: "gemini-4-argon", name: "Gemini 4 Argon" },
      { modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ]);
    expect(payload.models.currentModelId).toBe("gemini-3.8-flash");

    // Does not inject duplicate thought_level when thinking_level exists
    expect(payload.configOptions.filter((o) => o.id === "thought_level")).toHaveLength(0);
    expect(payload.configOptions.filter((o) => o.id === "thinking_level")).toHaveLength(1);
  });

  it("injects thought_level option into configOptions when native thinking_level is missing", () => {
    const cache = createSessionCache();
    const payload = {
      sessionId: "session-2",
      models: {
        availableModels: [
          { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
          { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
        ],
        currentModelId: "gemini-4-argon-high",
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          options: [
            { value: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
            { value: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
          ],
          currentValue: "gemini-4-argon-high",
        },
      ],
    };

    filterConfigOptions(payload, cache, "session-2");

    const thoughtOpt = payload.configOptions.find((o) => o.id === "thought_level");
    expect(thoughtOpt).toBeDefined();
    expect(thoughtOpt?.currentValue).toBe("high");
  });

  it("translates session/set_model with base model ID into composite upstream ID", async () => {
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "session-test");

    // Populate variants
    filterConfigOptions(
      {
        sessionId: "session-test",
        models: {
          availableModels: [
            { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
            { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
            { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
          ],
          currentModelId: "gemini-4-argon-high",
        },
      },
      cache,
      "session-test",
    );

    const context = createMockContext({ sessionCache: cache, session });
    const msg = {
      jsonrpc: "2.0" as const,
      id: 101,
      method: ACP_METHODS.SESSION_SET_MODEL,
      params: { sessionId: "session-test", modelId: "gemini-4-argon" },
    };

    const transformed = await flattenedModelEffortsFix.onOutbound?.(msg, context);
    expect(transformed && isJsonRpcRequest(transformed)).toBe(true);
    if (transformed && isJsonRpcRequest(transformed)) {
      expect(transformed.params).toEqual({
        sessionId: "session-test",
        modelId: "gemini-4-argon-high",
      });
    }
  });

  it("tracks thinking_level updates and applies the new effort to subsequent set_model calls", async () => {
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "session-effort");

    filterConfigOptions(
      {
        sessionId: "session-effort",
        models: {
          availableModels: [
            { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
            { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
          ],
          currentModelId: "gemini-4-argon-high",
        },
      },
      cache,
      "session-effort",
    );

    const context = createMockContext({ sessionCache: cache, session });

    // Client changes thinking_level to low
    const configMsg = {
      jsonrpc: "2.0" as const,
      id: 201,
      method: ACP_METHODS.SESSION_SET_CONFIG_OPTION,
      params: { sessionId: "session-effort", configId: "thinking_level", value: "low" },
    };
    await flattenedModelEffortsFix.onOutbound?.(configMsg, context);

    // Now set_model should compose with low effort
    const modelMsg = {
      jsonrpc: "2.0" as const,
      id: 202,
      method: ACP_METHODS.SESSION_SET_MODEL,
      params: { sessionId: "session-effort", modelId: "gemini-4-argon" },
    };
    const transformed = await flattenedModelEffortsFix.onOutbound?.(modelMsg, context);
    expect(transformed && isJsonRpcRequest(transformed)).toBe(true);
    if (transformed && isJsonRpcRequest(transformed)) {
      expect(transformed.params).toEqual({
        sessionId: "session-effort",
        modelId: "gemini-4-argon-low",
      });
    }
  });
});
