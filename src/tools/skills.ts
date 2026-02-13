/**
 * Skills tools — skill discovery, creation, and management.
 *
 * Keeps SKILL.md parsing, index-first loading (only names+descriptions in system prompt).
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readdirSync, mkdirSync, rmSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  source: "builtin" | "workspace";
  always?: boolean;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  always?: string | boolean;
}

const BUILTIN_SKILLS_DIR = resolve(import.meta.dir, "../../skills");
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export class SkillLoader {
  private builtinDir: string;
  private workspaceDir: string;

  constructor(workspace: string, builtinDir?: string) {
    this.builtinDir = builtinDir ?? BUILTIN_SKILLS_DIR;
    this.workspaceDir = join(workspace, "skills");
  }

  async listSkills(): Promise<SkillEntry[]> {
    const skills: SkillEntry[] = [];
    const seen = new Set<string>();

    for (const dir of this.readSkillDirs(this.workspaceDir)) {
      const entry = await this.loadEntry(dir, this.workspaceDir, "workspace");
      if (entry) { skills.push(entry); seen.add(entry.name); }
    }
    for (const dir of this.readSkillDirs(this.builtinDir)) {
      const entry = await this.loadEntry(dir, this.builtinDir, "builtin");
      if (entry && !seen.has(entry.name)) skills.push(entry);
    }

    return skills;
  }

  async loadSkill(name: string): Promise<string | null> {
    const wsFile = Bun.file(join(this.workspaceDir, name, "SKILL.md"));
    if (await wsFile.exists()) return wsFile.text();
    const builtinFile = Bun.file(join(this.builtinDir, name, "SKILL.md"));
    if (await builtinFile.exists()) return builtinFile.text();
    return null;
  }

  async buildSkillsSummary(): Promise<string | null> {
    const skills = await this.listSkills();
    if (!skills.length) return null;

    const lines = ["<skills>"];
    for (const s of skills) {
      const esc = (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      lines.push(`  <skill><name>${esc(s.name)}</name><description>${esc(s.description)}</description></skill>`);
    }
    lines.push("</skills>");
    return lines.join("\n");
  }

  private readSkillDirs(base: string): string[] {
    try { return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { return []; }
  }

  private async loadEntry(dirName: string, base: string, source: "builtin" | "workspace"): Promise<SkillEntry | null> {
    const skillPath = join(base, dirName, "SKILL.md");
    const file = Bun.file(skillPath);
    if (!(await file.exists())) return null;
    const content = await file.text();
    const meta = this.parseFrontmatter(content);
    return { name: meta.name ?? dirName, description: meta.description ?? dirName, path: skillPath, source, always: meta.always === true || meta.always === "true" };
  }

  private parseFrontmatter(content: string): SkillFrontmatter {
    if (!content.startsWith("---")) return {};
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const meta: SkillFrontmatter = {};
    for (const line of match[1]!.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "name") meta.name = value;
      else if (key === "description") meta.description = value;
      else if (key === "always") meta.always = value;
    }
    return meta;
  }
}

export function registerSkillTools(deps: { skillLoader: SkillLoader; workspace: string }): ToolSet {
  const { skillLoader, workspace } = deps;
  const skillsDir = join(workspace, "skills");
  mkdirSync(skillsDir, { recursive: true });

  const skills = tool({
    description: "Manage skills. Actions: list (show all skills), load (read a skill's content), create (create a new skill).",
    inputSchema: z.object({
      action: z.enum(["list", "load", "create"]).describe("Action to perform"),
      name: z.string().optional().describe("Skill name (for load/create)"),
      description: z.string().optional().describe("One-line description (for create)"),
      instructions: z.string().optional().describe("Detailed Markdown instructions (for create)"),
      always: z.boolean().optional().default(false).describe("Always include in context (for create)"),
    }),
    execute: async ({ action, name, description, instructions, always }) => {
      if (action === "list") {
        const all = await skillLoader.listSkills();
        return { success: true, skills: all.map((s) => ({ name: s.name, description: s.description, source: s.source })), count: all.length };
      }

      if (action === "load") {
        if (!name) return { success: false, error: "name is required for load" };
        const content = await skillLoader.loadSkill(name);
        if (!content) return { success: false, error: `Skill "${name}" not found` };
        return { success: true, content };
      }

      if (action === "create") {
        if (!name || !description || !instructions) return { success: false, error: "name, description, and instructions are required" };
        if (!SKILL_NAME_PATTERN.test(name)) return { success: false, error: "Name must be lowercase letters, numbers, and hyphens" };

        const dir = join(skillsDir, name);
        const path = join(dir, "SKILL.md");
        if (await Bun.file(path).exists()) return { success: false, error: `Skill "${name}" already exists` };

        const frontmatter = ["---", `name: ${name}`, `description: ${description}`, ...(always ? ["always: true"] : []), "---"].join("\n");
        mkdirSync(dir, { recursive: true });
        await Bun.write(path, `${frontmatter}\n\n${instructions}\n`);
        return { success: true, path, name };
      }

      return { success: false, error: "Unknown action" };
    },
  });

  return { skills };
}
