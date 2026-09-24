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
    while (idx < lines.length) {
      const line = lines[idx];
      if (line === undefined || (!/^\s+/.test(line) && line.trim().length !== 0)) {
        break;
      }
      block.push(line.trim());
      idx++;
    }
    const text = rest.startsWith(">") ? block.join(" ") : block.join("\n").trim();
    return { desc: text, nextIndex: idx - 1 };
  }
  return { desc: unquote(rest), nextIndex: i };
}

function parseFrontmatter(frontmatter: string): {
  name?: string | undefined;
  description?: string | undefined;
  userInvocable: boolean;
} {
  const lines = frontmatter.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let userInvocable = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch && nameMatch[1] !== undefined) name = unquote(nameMatch[1]);

    const invocableMatch = line.match(/^(?:user-invocable|user_invocable):\s*(.*)$/);
    if (invocableMatch && invocableMatch[1] !== undefined) {
      userInvocable = parseInvocable(invocableMatch[1]);
    }

    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch && descMatch[1] !== undefined) {
      const parsed = parseDescription(descMatch[1].trim(), lines, i);
      description = parsed.desc;
      i = parsed.nextIndex;
    }
  }
  return { name, description, userInvocable };
}

function extractFrontmatterAndBody(content: string): {
  meta: { name?: string | undefined; description?: string | undefined; userInvocable: boolean };
  instructions: string;
} {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)([\s\S]*)$/);
  if (!fmMatch) return { meta: { userInvocable: true }, instructions: content };
  const frontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? content;
  return { meta: parseFrontmatter(frontmatter), instructions: body.trim() };
}

export function parseSkillFile(filePath: string): DiscoveredSkill | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const { meta, instructions } = extractFrontmatterAndBody(content);
    const fallbackName = path.basename(path.dirname(filePath));

    return {
      name: meta.name || fallbackName,
      description: meta.description || `Skill: ${fallbackName}`,
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

interface SkillsCacheEntry {
  timestamp: number;
  skills: Map<string, DiscoveredSkill>;
}

const skillsCache = new Map<string, SkillsCacheEntry>();
const SKILLS_CACHE_TTL_MS = 5000;

function scanSkillRoot(root: string, skills: Map<string, DiscoveredSkill>): void {
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

export function discoverSkills(cwd?: string): Map<string, DiscoveredSkill> {
  const key = cwd ?? "";
  const now = Date.now();
  const cached = skillsCache.get(key);
  if (cached && now - cached.timestamp < SKILLS_CACHE_TTL_MS) {
    return cached.skills;
  }

  const roots = resolveSkillRoots(cwd);
  const skills = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    scanSkillRoot(root, skills);
  }

  skillsCache.set(key, { timestamp: now, skills });
  return skills;
}

export const BUILTIN_COMMANDS: AvailableCommand[] = [
  {
    name: "boost",
    description:
      "Deep thinking, strategic planning, multiple perspectives, and rigorous verification (https://antigravity.google/docs/boost/)",
  },
  {
    name: "teamwork",
    description:
      "Coordinate a team of autonomous subagents working together on complex tasks (https://antigravity.google/docs/teamwork/)",
  },
  {
    name: "teamwork-preview",
    description: "Preview multi-agent team orchestration for collaborative parallel tasks",
  },
  {
    name: "goal",
    description: "Run a long-running task autonomously until the goal is fully achieved",
  },
  {
    name: "plan",
    description: "Plan complex tasks step-by-step before execution",
  },
  {
    name: "schedule",
    description: "Run an instruction on a recurring schedule or set a one-time timer",
  },
  {
    name: "browser",
    description: "Interact with web applications and browse the web",
  },
  {
    name: "grill-me",
    description: "Interactive interview to resolve design decisions and align on plans",
  },
  {
    name: "learn",
    description: "Persist learnings, corrections, and complex setups for future tasks",
  },
];

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
  for (const cmd of BUILTIN_COMMANDS) {
    if (!result.has(cmd.name)) {
      result.set(cmd.name, cmd);
    }
  }
  for (const skill of discoverSkills(cwd).values()) {
    if (skill.userInvocable && !result.has(skill.name)) {
      result.set(skill.name, { name: skill.name, description: skill.description });
    }
  }
  return Array.from(result.values());
}

export function formatSkillsCatalog(skills: Map<string, DiscoveredSkill>): string {
  if (skills.size === 0) return "";

  const lines = Array.from(skills.values()).map(
    (skill) => `- ${skill.name} (${skill.filePath}): ${skill.description}`,
  );

  return [
    "<skills>",
    "You can use specialized 'skills' to help you with complex tasks.",
    "If a skill seems relevant to your current task, read its SKILL.md instructions using your file reading tool before proceeding.",
    "",
    "Available skills:",
    ...lines,
    "</skills>",
  ].join("\n");
}
