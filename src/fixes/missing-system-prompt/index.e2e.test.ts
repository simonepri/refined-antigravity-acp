import { describe, expect, it } from "vitest";
import { formatSystemContext, stripSystemContext } from "./index.js";
import { spawnWrapped } from "../../test-utils/index.js";

describe("missing-system-prompt e2e", () => {
  it("formats and strips system instructions cleanly", () => {
    const formatted = formatSystemContext("You are an SRE.", ["Instruction 1"]);
    expect(formatted).toContain("<user_instruction>\nYou are an SRE.\n</user_instruction>");
    expect(formatted).toContain("<system_instruction>");

    const fullPrompt = `${formatted}\n\nList the cluster pods.`;
    expect(stripSystemContext(fullPrompt)).toBe("List the cluster pods.");
  });

  it("solution: wrapped connector accepts session with custom systemPrompt in _meta", async () => {
    const client = await spawnWrapped();
    try {
      await client.initialize();
      const res = await client.newSession({
        _meta: { systemPrompt: "You are an autonomous tester." },
      });
      expect(res.sessionId).toBeDefined();
    } finally {
      await client.close();
    }
  });
});
