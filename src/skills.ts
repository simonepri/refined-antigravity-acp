import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AvailableCommand {
  name: string;
  description: string;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  instructions: string;
  userInvocable: boolean;
  filePath: string;
}

function unquote(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  const commentIdx = trimmed.search(/\s+#/);
  return commentIdx !== -1 ? trimmed.slice(0, commentIdx).trim() : trimmed;
}

function parseInvocable(val: string): boolean {
  const v = unquote(val).toLowerCase();
  return v !== "false" && v !== "no" && v !== "0";
}

function parseDescription(
  rest: string,
  lines: string[],
  i: number,
): { desc: string; nextIndex: number } {
  if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
    const block: string[] = [];
    let idx = i + 1;
    while (idx < lines.length && (/^\s+/.test(lines[idx]) || lines[idx].trim().length === 0)) {
      block.push(lines[idx].trim());
      idx++;
    }
    const text = rest.startsWith(">") ? block.join(" ") : block.join("\n").trim();
    return { desc: text, nextIndex: idx - 1 };
  }
  return { desc: unquote(rest), nextIndex: i };
}

function parseFrontmatter(frontmatter: string): {
  name?: string;
  description?: string;
  userInvocable: boolean;
} {
  const lines = frontmatter.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let userInvocable = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) name = unquote(nameMatch[1]);

    const invocableMatch = line.match(/^(?:user-invocable|user_invocable):\s*(.*)$/);
    if (invocableMatch) userInvocable = parseInvocable(invocableMatch[1]);

    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      const parsed = parseDescription(descMatch[1].trim(), lines, i);
      description = parsed.desc;
      i = parsed.nextIndex;
    }
  }
  return { name, description, userInvocable };
}

export function parseSkillFile(filePath: string): DiscoveredSkill | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)([\s\S]*)$/);
    const meta = fmMatch ? parseFrontmatter(fmMatch[1]) : { userInvocable: true };
    const instructions = fmMatch ? fmMatch[2].trim() : content;
    const fallbackName = path.basename(path.dirname(filePath));

    return {
      name: meta.name && meta.name.length > 0 ? meta.name : fallbackName,
      description:
        meta.description && meta.description.length > 0
          ? meta.description
          : `Skill: ${fallbackName}`,
      instructions,
      userInvocable: meta.userInvocable,
      filePath,
    };
  } catch {
    return null;
  }
}

export function resolveSkillRoots(cwd?: string): string[] {
  const candidates: string[] = [];
  if (cwd) {
    candidates.push(
      path.join(cwd, ".agents/skills"),
      path.join(cwd, ".gemini/skills"),
      path.join(cwd, ".codex/skills"),
      path.join(cwd, "skills"),
    );
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, ".gemini/antigravity-cli/skills"),
    path.join(home, ".gemini/config/skills"),
    path.join(home, ".gemini/skills"),
    path.join(home, ".agents/skills"),
    path.join(home, ".claude/skills"),
    path.join(home, ".codex/skills"),
  );
  return Array.from(new Set(candidates.filter((dir) => existsSync(dir))));
}

export function discoverSkills(cwd?: string): Map<string, DiscoveredSkill> {
  const roots = resolveSkillRoots(cwd);
  const skills = new Map<string, DiscoveredSkill>();

  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skill = parseSkillFile(path.join(root, entry.name, "SKILL.md"));
        if (skill && !skills.has(skill.name)) {
          skills.set(skill.name, skill);
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }
  return skills;
}

export function augmentCommands(
  existingCommands: AvailableCommand[] | undefined,
  cwd?: string,
): AvailableCommand[] {
  const result = new Map<string, AvailableCommand>();
  if (Array.isArray(existingCommands)) {
    for (const cmd of existingCommands) {
      if (cmd?.name) result.set(cmd.name, cmd);
    }
  }
  for (const skill of discoverSkills(cwd).values()) {
    if (skill.userInvocable && !result.has(skill.name)) {
      result.set(skill.name, { name: skill.name, description: skill.description });
    }
  }
  return Array.from(result.values());
}

export function expandSkillInvocation(text: string, cwd?: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return text;
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;

  const [_, commandName, rawArgs] = match;
  const args = rawArgs ?? "";
  const skill = discoverSkills(cwd).get(commandName);
  if (!skill) return text;

  let expanded = skill.instructions;
  if (expanded.includes("$ARGUMENTS")) {
    expanded = expanded.replaceAll("$ARGUMENTS", args);
  } else if (args.trim().length > 0) {
    expanded = `${expanded}\n\n**Arguments:** ${args}`;
  }
  return `[Skill: ${skill.name}]\n${expanded}\n[/Skill: ${skill.name}]`;
}
