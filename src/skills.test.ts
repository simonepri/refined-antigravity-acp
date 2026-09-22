import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  augmentCommands,
  discoverSkills,
  expandSkillInvocation,
  parseSkillFile,
} from "./skills.js";

describe("skills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-test-skills-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses skill file with YAML frontmatter", () => {
    const skillDir = path.join(tmpDir, "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      `---
name: my-skill
description: Custom test skill
user-invocable: true
---

Instructions here for $ARGUMENTS.`,
    );

    const skill = parseSkillFile(skillPath);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("my-skill");
    expect(skill?.description).toBe("Custom test skill");
    expect(skill?.userInvocable).toBe(true);
    expect(skill?.instructions).toBe("Instructions here for $ARGUMENTS.");
  });

  it("handles user-invocable: false", () => {
    const skillDir = path.join(tmpDir, "internal-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      `---
name: internal-skill
description: Internal skill
user-invocable: false
---

Instructions.`,
    );

    const skill = parseSkillFile(skillPath);
    expect(skill?.userInvocable).toBe(false);
  });

  it("discovers skills in workspace directory", () => {
    const wsSkills = path.join(tmpDir, ".gemini", "skills", "sample");
    fs.mkdirSync(wsSkills, { recursive: true });
    fs.writeFileSync(
      path.join(wsSkills, "SKILL.md"),
      `---
name: sample
description: Sample skill
---
Do something.`,
    );

    const skills = discoverSkills(tmpDir);
    expect(skills.has("sample")).toBe(true);
    expect(skills.get("sample")?.description).toBe("Sample skill");
  });

  it("augments commands list with discovered skills", () => {
    const wsSkills = path.join(tmpDir, ".agents", "skills", "test-skill");
    fs.mkdirSync(wsSkills, { recursive: true });
    fs.writeFileSync(
      path.join(wsSkills, "SKILL.md"),
      `---
name: test-skill
description: A workspace skill
---
Do something.`,
    );

    const commands = augmentCommands([{ name: "help", description: "Help" }], tmpDir);
    expect(commands.some((c) => c.name === "test-skill")).toBe(true);
    expect(commands.some((c) => c.name === "help")).toBe(true);
  });

  it("expands skill invocation with arguments substitution", () => {
    const wsSkills = path.join(tmpDir, ".agents", "skills", "greet");
    fs.mkdirSync(wsSkills, { recursive: true });
    fs.writeFileSync(
      path.join(wsSkills, "SKILL.md"),
      `---
name: greet
description: Greet someone
---
Say hello to $ARGUMENTS now!`,
    );

    const expanded = expandSkillInvocation("/greet Alice", tmpDir);
    expect(expanded).toContain("[Skill: greet]");
    expect(expanded).toContain("Say hello to Alice now!");
    expect(expanded).toContain("[/Skill: greet]");
  });

  it("leaves non-skill commands untouched", () => {
    const text = "/unknown-command foo bar";
    expect(expandSkillInvocation(text, tmpDir)).toBe(text);
  });
});
