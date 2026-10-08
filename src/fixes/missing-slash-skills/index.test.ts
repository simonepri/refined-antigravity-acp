import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  parseSkillFile,
  formatSkillsCatalog,
  augmentCommands,
  injectSkillsCatalog,
  slashSkillsFix,
  type DiscoveredSkill,
} from "./index.js";
import { ACP_METHODS, type AcpStreamMessage, type OutboundContext } from "../../core/types.js";
import { createSessionCache, getOrCreateSession } from "../../core/session-cache.js";

describe("missing-slash-skills unit tests", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.REFINED_AGY_INJECT_SKILLS;
    delete process.env.REFINED_AGY_INJECT_SKILLS;
  });

  afterEach(() => {
    if (prevEnv !== undefined) {
      process.env.REFINED_AGY_INJECT_SKILLS = prevEnv;
    } else {
      delete process.env.REFINED_AGY_INJECT_SKILLS;
    }
  });

  it("discovers skill declarations and metadata from workspace skill definitions", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-parse-"));
    const skillPath = path.join(tempDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      `---
name: code-review
description: Review pull requests for bugs and patterns
user-invocable: true
---
Detailed review guidelines...`,
    );

    const skill = parseSkillFile(skillPath);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("code-review");
    expect(skill?.description).toBe("Review pull requests for bugs and patterns");
    expect(skill?.userInvocable).toBe(true);
    expect(skill?.instructions).toBe("Detailed review guidelines...");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("formats discovered skills into system context block for agent prompting", () => {
    const skills = new Map<string, DiscoveredSkill>([
      [
        "lint",
        {
          name: "lint",
          description: "Run linter",
          instructions: "Run oxlint",
          userInvocable: true,
          filePath: "/path/to/lint/SKILL.md",
        },
      ],
    ]);

    const formatted = formatSkillsCatalog(skills);
    expect(formatted).toContain("<skills>");
    expect(formatted).toContain("- lint (/path/to/lint/SKILL.md): Run linter");
    expect(formatted).toContain("</skills>");
  });

  it("registers user-invocable skills as slash commands without duplicating existing entries", () => {
    const existing = [{ name: "existing-cmd", description: "Existing" }];
    const augmented = augmentCommands(existing);
    expect(augmented.some((c) => c.name === "existing-cmd")).toBe(true);
  });

  it("advertises built-in commands like boost and teamwork so clients discover available capabilities", () => {
    const augmented = augmentCommands([]);
    expect(augmented.some((c) => c.name === "boost")).toBe(true);
    expect(augmented.some((c) => c.name === "teamwork")).toBe(true);
    expect(augmented.some((c) => c.name === "plan")).toBe(true);
    expect(augmented.some((c) => c.name === "goal")).toBe(true);
  });

  it("injects discovered workspace skills catalog into the prompt instructions", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-inject-"));
    const skillDir = path.join(tempDir, ".agents", "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: test-skill
description: A test skill
---
Do testing`,
    );

    const promptChunks = [{ type: "text", text: "Please review my code" }];
    injectSkillsCatalog(promptChunks, tempDir);

    expect(promptChunks[0]?.text).toContain("<skills>");
    expect(promptChunks[0]?.text).toContain("test-skill");
    expect(promptChunks[0]?.text).toContain("Please review my code");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("injects skills catalog on initial session turn and preserves clean context on subsequent turns", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-turn-"));
    const skillDir = path.join(tempDir, ".agents", "skills", "audit");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: audit
description: Security audit
---
Perform audit`,
    );

    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "s-1");
    session.cwd = tempDir;

    const context = {
      sessionCache: cache,
      session,
      forwardInbound: () => {},
      writeToChild: async () => {},
      sendInternalRequest: async (m: AcpStreamMessage) => m,
      triggerRecycle: async () => {},
      declareHang: () => {},
    } as OutboundContext;

    const firstPromptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "s-1",
        prompt: [{ type: "text", text: "First turn" }],
      },
    };

    slashSkillsFix.onOutbound?.(firstPromptMsg, context);
    const firstParams = firstPromptMsg.params as { prompt: Array<{ text: string }> };
    expect(firstParams.prompt[0]?.text).toContain("<skills>");
    expect(firstParams.prompt[0]?.text).toContain("audit");

    // Second turn should NOT re-inject
    const secondPromptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "s-1",
        prompt: [{ type: "text", text: "Second turn" }],
      },
    };

    slashSkillsFix.onOutbound?.(secondPromptMsg, context);
    const secondParams = secondPromptMsg.params as { prompt: Array<{ text: string }> };
    expect(secondParams.prompt[0]?.text).not.toContain("<skills>");
    expect(secondParams.prompt[0]?.text).toBe("Second turn");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips skills injection when REFINED_AGY_INJECT_SKILLS is set to 0", () => {
    process.env.REFINED_AGY_INJECT_SKILLS = "0";
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "s-env");
    const context = { sessionCache: cache, session } as OutboundContext;

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "s-env",
        prompt: [{ type: "text", text: "Turn text" }],
      },
    };

    slashSkillsFix.onOutbound?.(promptMsg, context);
    const params = promptMsg.params as { prompt: Array<{ text: string }> };
    expect(params.prompt[0]?.text).toBe("Turn text");
  });

  it("skips skills injection when prompt already contains available_skills", () => {
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "s-existing");
    const context = { sessionCache: cache, session } as OutboundContext;

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "s-existing",
        prompt: [
          { type: "text", text: "<available_skills>\n- foo\n</available_skills>\n\nUser text" },
        ],
      },
    };

    slashSkillsFix.onOutbound?.(promptMsg, context);
    const params = promptMsg.params as { prompt: Array<{ text: string }> };
    expect(params.prompt[0]?.text).not.toContain("<skills>");
    expect(params.prompt[0]?.text).toContain("<available_skills>");
  });
});
