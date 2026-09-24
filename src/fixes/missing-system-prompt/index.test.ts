import { describe, expect, it } from "vitest";
import {
  systemPromptFix,
  formatSystemContext,
  stripSystemContext,
  extractSystemPrompt,
} from "./index.js";
import type { AcpFix, AcpStreamMessage, OutboundContext } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { getOrCreateSession } from "../../core/session-cache.js";

describe("systemPromptFix", () => {
  it("injects system instructions aggregated across all registered fixes on the first prompt turn", () => {
    const mockFixA: AcpFix = {
      name: "fix-a",
      getSystemInstructions: () => ["Instruction from Fix A"],
    };
    const mockFixB: AcpFix = {
      name: "fix-b",
      getSystemInstructions: () => ["Instruction B.1", "Instruction B.2"],
    };

    const context: OutboundContext = {
      ...createMockContext(),
      fixes: [mockFixA, mockFixB, systemPromptFix],
    };

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "Explain quantum computing" }],
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(promptMsg, context);

    const firstChunk = (promptMsg as { params: { prompt: Array<{ text: string }> } }).params
      .prompt[0]!;
    expect(firstChunk.text).toContain("<system_instruction>");
    expect(firstChunk.text).toContain("- Instruction from Fix A");
    expect(firstChunk.text).toContain("- Instruction B.1");
    expect(firstChunk.text).toContain("- Instruction B.2");
    expect(firstChunk.text).toContain("Explain quantum computing");
  });

  it("combines sibling fix instructions with client system prompt in separate instruction tags", () => {
    const mockFix: AcpFix = {
      name: "fix-math",
      getSystemInstructions: () => ["Use plain Unicode symbols."],
    };

    const context: OutboundContext = {
      ...createMockContext(),
      fixes: [mockFix, systemPromptFix],
    };

    // Client sends session/new with systemPrompt
    const newMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 10,
      method: "session/new",
      params: {
        _meta: { systemPrompt: "You are an expert mathematician." },
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(newMsg, context);

    // Later session cache maps id 10 to session "s2"
    const session = getOrCreateSession(context.sessionCache, "s2");
    session.fixData = context.sessionCache.pendingSessionMetadata.get(10)?.fixData ?? new Map();

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: {
        sessionId: "s2",
        prompt: [{ type: "text", text: "Calculate 2+2" }],
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(promptMsg, context);

    const firstChunk = (promptMsg as { params: { prompt: Array<{ text: string }> } }).params
      .prompt[0]!;
    expect(firstChunk.text).toContain(
      "<system_instruction>\n- Use plain Unicode symbols.\n</system_instruction>",
    );
    expect(firstChunk.text).toContain(
      "<user_instruction>\nYou are an expert mathematician.\n</user_instruction>",
    );
    expect(firstChunk.text).toContain("Calculate 2+2");
  });

  it("does not mutate outbound prompt when neither sibling fixes nor client provide instructions", () => {
    const context: OutboundContext = {
      ...createMockContext(),
      fixes: [systemPromptFix],
    };

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s3",
        prompt: [{ type: "text", text: "Hello there" }],
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(promptMsg, context);

    const firstChunk = (promptMsg as { params: { prompt: Array<{ text: string }> } }).params
      .prompt[0]!;
    expect(firstChunk.text).toBe("Hello there");
  });

  it("injects instructions only once per session and leaves subsequent prompts untouched", () => {
    const mockFix: AcpFix = {
      name: "steering",
      getSystemInstructions: () => ["Acknowledge steering."],
    };

    const context: OutboundContext = {
      ...createMockContext(),
      fixes: [mockFix, systemPromptFix],
    };

    const prompt1: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s4",
        prompt: [{ type: "text", text: "First turn" }],
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(prompt1, context);

    const chunk1 = (prompt1 as { params: { prompt: Array<{ text: string }> } }).params.prompt[0]!;
    expect(chunk1.text).toContain("<system_instruction>");

    const prompt2: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "s4",
        prompt: [{ type: "text", text: "Second turn" }],
      },
    } as unknown as AcpStreamMessage;

    systemPromptFix.onOutbound?.(prompt2, context);

    const chunk2 = (prompt2 as { params: { prompt: Array<{ text: string }> } }).params.prompt[0]!;
    expect(chunk2.text).toBe("Second turn");
  });
});

describe("formatSystemContext and stripSystemContext", () => {
  it("formats instructions and strips both system and user instruction tags", () => {
    const formatted = formatSystemContext("System role", ["Instruction 1", "Instruction 2"]);
    expect(formatted).toContain(
      "<system_instruction>\n- Instruction 1\n- Instruction 2\n</system_instruction>",
    );
    expect(formatted).toContain("<user_instruction>\nSystem role\n</user_instruction>");

    const fullMessage = `${formatted}\n\nUser query here`;
    expect(stripSystemContext(fullMessage)).toBe("User query here");
  });
});

describe("extractSystemPrompt", () => {
  it("extracts system prompt from top-level _meta or nested objects", () => {
    const direct: AcpStreamMessage = {
      jsonrpc: "2.0",
      params: {
        _meta: { systemPrompt: "Direct prompt" },
      },
    } as unknown as AcpStreamMessage;
    expect(extractSystemPrompt(direct)).toBe("Direct prompt");

    const nested: AcpStreamMessage = {
      jsonrpc: "2.0",
      params: {
        _meta: { custom: { systemPrompt: "Nested prompt" } },
      },
    } as unknown as AcpStreamMessage;
    expect(extractSystemPrompt(nested)).toBe("Nested prompt");
  });
});
