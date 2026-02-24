/**
 * Skills tools — skill discovery, creation, management, search, preview, and install.
 *
 * Merged from skills.ts + skillshop.ts into a single unified tool with 6 actions.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readdirSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { log } from "../log.js";

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
const MAX_SKILL_SIZE_BYTES = 100_000;

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

// --- Safety scanner (from skillshop) ---

interface ScanResult {
  safe: boolean;
  reasons: string[];
}

const PATTERN_WEIGHTS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /steal\s+(api\s*key|password|token|secret|credential)/i, weight: 30 },
  { pattern: /exfiltrat/i, weight: 30 },
  { pattern: /send\s+.*(api.?key|password|token|secret|credential).*to/i, weight: 30 },
  { pattern: /transmit\s+.*(key|secret|password)/i, weight: 25 },
  { pattern: /ignore\s+all\s+previous\s+instructions/i, weight: 25 },
  { pattern: /disregard\s+(your|all)\s+(previous\s+)?instructions/i, weight: 25 },
  { pattern: /override\s+(safety|security)\s+(rules?|guidelines?)/i, weight: 25 },
  { pattern: /you\s+are\s+now\s+.*\bDAN\b/i, weight: 25 },
  { pattern: /rm\s+-rf/i, weight: 20 },
  { pattern: /sudo\s+rm/i, weight: 20 },
  { pattern: /format\s+c:/i, weight: 20 },
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh|fish)/i, weight: 20 },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh|fish)/i, weight: 20 },
  { pattern: /upload\s+.*(env|credential|password|secret)/i, weight: 20 },
  { pattern: /read\s+\.env\s+.*send/i, weight: 15 },
  { pattern: /access\s+\.env\s+.*transmit/i, weight: 15 },
  { pattern: /fetch\s*\(/i, weight: 5 },
  { pattern: /axios\s*\./i, weight: 5 },
  { pattern: /http\.get\s*\(/i, weight: 5 },
  { pattern: /curl\s+/i, weight: 3 },
  { pattern: /wget\s+/i, weight: 3 },
];

function calculateSafeScore(content: string): number {
  let score = 100;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_SKILL_SIZE_BYTES) score -= 40;
  else if (bytes > 50_000) score -= 10;
  for (const { pattern, weight } of PATTERN_WEIGHTS) {
    if (pattern.test(content)) score -= weight;
  }
  return Math.max(0, score);
}

function scanContent(content: string): ScanResult {
  const reasons: string[] = [];
  if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_SIZE_BYTES) {
    reasons.push(`File too large (>${MAX_SKILL_SIZE_BYTES / 1000}KB) — suspicious for a SKILL.md`);
  }
  for (const { pattern } of PATTERN_WEIGHTS) {
    if (pattern.test(content)) {
      reasons.push(`Matched unsafe pattern: ${pattern.source}`);
    }
  }
  return { safe: reasons.length === 0, reasons };
}

// --- GitHub URL helpers ---

function toRawUrl(url: string): string | null {
  if (url.includes("raw.githubusercontent.com")) return url;
  const match = url.match(/https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)/);
  if (!match) return null;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
}

function deriveSkillMdUrl(url: string): string | null {
  if (url.includes("SKILL.md")) return toRawUrl(url);
  const ghDir = url.match(/https?:\/\/github\.com\/[^/]+\/[^/]+(?:\/tree\/[^/]+)?(\/[^?#]*)?/);
  if (ghDir) {
    const raw = url
      .replace("github.com", "raw.githubusercontent.com")
      .replace(/\/tree\//, "/")
      .replace(/\/$/, "");
    return `${raw}/SKILL.md`;
  }
  return null;
}

function nameFromUrl(url: string): string {
  const parts = url.replace(/\/$/, "").split("/");
  const last = parts[parts.length - 1] ?? "";
  if (last && last !== "SKILL.md" && SKILL_NAME_PATTERN.test(last)) return last;
  const second = parts[parts.length - 2] ?? "";
  if (second && SKILL_NAME_PATTERN.test(second)) return second;
  const repoIdx = url.includes("github.com") ? url.indexOf("github.com") : -1;
  if (repoIdx !== -1) {
    const repoSlug = url.slice(repoIdx).split("/")[2] ?? "skill";
    return repoSlug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  }
  return "skill";
}

function parseFrontmatterName(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === "name") {
      return line.slice(idx + 1).trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  }
  return null;
}

function addAttribution(content: string, source: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (content.startsWith("---")) {
    return content.replace("---\n", `---\nsource: ${source}\ninstalled_at: ${today}\n`);
  }
  return `---\nsource: ${source}\ninstalled_at: ${today}\n---\n\n${content}`;
}

// --- Unified tool registration ---

export function registerSkillTools(deps: {
  skillLoader: SkillLoader;
  workspace: string;
  exaApiKey?: string;
  githubToken?: string;
}): ToolSet {
  const { skillLoader, workspace } = deps;
  const skillsDir = join(workspace, "skills");
  mkdirSync(skillsDir, { recursive: true });

  const ghHeaders: Record<string, string> = { "User-Agent": "koda-skillshop/1.0" };
  if (deps.githubToken) ghHeaders["Authorization"] = `Bearer ${deps.githubToken}`;

  const skills = tool({
    description:
      "Manage skills. Actions: list (show all), load (read content), create (new skill), " +
      "search (find community skills), preview (inspect before installing), install (download + save).",
    inputSchema: z.discriminatedUnion("action", [
      z.object({ action: z.literal("list") }),
      z.object({ action: z.literal("load"), name: z.string() }),
      z.object({
        action: z.literal("create"),
        name: z.string(),
        description: z.string(),
        instructions: z.string(),
        always: z.boolean().optional().default(false),
      }),
      z.object({ action: z.literal("search"), query: z.string() }),
      z.object({ action: z.literal("preview"), rawUrl: z.string().url() }),
      z.object({
        action: z.literal("install"),
        rawUrl: z.string().url(),
        name: z.string().optional(),
      }),
    ]),
    execute: async (input) => {
      // --- LIST ---
      if (input.action === "list") {
        const all = await skillLoader.listSkills();
        return { success: true, skills: all.map((s) => ({ name: s.name, description: s.description, source: s.source })), count: all.length };
      }

      // --- LOAD ---
      if (input.action === "load") {
        const content = await skillLoader.loadSkill(input.name);
        if (!content) return { success: false, error: `Skill "${input.name}" not found` };
        return { success: true, content };
      }

      // --- CREATE ---
      if (input.action === "create") {
        const { name, description, instructions, always } = input;
        if (!SKILL_NAME_PATTERN.test(name)) return { success: false, error: "Name must be lowercase letters, numbers, and hyphens" };

        const dir = join(skillsDir, name);
        const path = join(dir, "SKILL.md");
        if (await Bun.file(path).exists()) return { success: false, error: `Skill "${name}" already exists` };

        const frontmatter = ["---", `name: ${name}`, `description: ${description}`, ...(always ? ["always: true"] : []), "---"].join("\n");
        mkdirSync(dir, { recursive: true });
        await Bun.write(path, `${frontmatter}\n\n${instructions}\n`);
        return { success: true, path, name };
      }

      // --- SEARCH ---
      if (input.action === "search") {
        if (!deps.exaApiKey) return { success: false, error: "Skill shop requires Exa API key." };
        log("skills", "search: %s", input.query);
        try {
          const Exa = (await import("exa-js")).default;
          const exa = new Exa(deps.exaApiKey);
          const result = await exa.searchAndContents(
            `${input.query} skill SKILL.md agent site:github.com OR site:skills.sh`,
            { type: "auto", numResults: 8, highlights: { maxCharacters: 500 } },
          );

          const results = result.results
            .filter((r) => {
              const u = r.url.toLowerCase();
              return u.includes("github.com") || u.includes("skills.sh");
            })
            .map((r, i) => {
              const skillMdUrl = deriveSkillMdUrl(r.url);
              const rawUrl = skillMdUrl ?? r.url;
              const name = nameFromUrl(r.url);
              const snippet = ((r as any).highlights ?? [])[0] ?? (r.title ?? "");
              return { index: i + 1, name, title: r.title ?? name, description: snippet, githubUrl: r.url, rawUrl };
            });

          return {
            success: results.length > 0,
            query: input.query,
            results,
            count: results.length,
            tip: results.length > 0
              ? `To install, use skills install with rawUrl="${results[0]?.rawUrl}"`
              : "Try a different search term.",
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Search failed", results: [] };
        }
      }

      // --- PREVIEW ---
      if (input.action === "preview") {
        if (!deps.exaApiKey) return { success: false, error: "Skill shop requires Exa API key." };
        log("skills", "preview: %s", input.rawUrl);
        const rawUrl = toRawUrl(input.rawUrl) ?? input.rawUrl;
        try {
          const res = await fetch(rawUrl, { headers: ghHeaders });
          if (!res.ok) return { success: false, error: `HTTP ${res.status} fetching ${rawUrl}` };
          const content = await res.text();

          const scan = scanContent(content);
          const fmName = parseFrontmatterName(content);

          return {
            success: true,
            rawUrl,
            name: fmName ?? nameFromUrl(rawUrl),
            content,
            safe: scan.safe,
            safeScore: calculateSafeScore(content),
            safetyWarnings: scan.reasons,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
            note: scan.safe
              ? "Looks safe. Say 'install' to add it to your skills."
              : `Safety warnings found — review before installing: ${scan.reasons.join("; ")}`,
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Preview fetch failed" };
        }
      }

      // --- INSTALL ---
      if (input.action === "install") {
        if (!deps.exaApiKey) return { success: false, error: "Skill shop requires Exa API key." };
        log("skills", "install: %s", input.rawUrl);
        const rawUrl = toRawUrl(input.rawUrl) ?? input.rawUrl;
        try {
          const res = await fetch(rawUrl, { headers: ghHeaders });
          if (!res.ok) return { success: false, error: `HTTP ${res.status} fetching ${rawUrl}` };
          const content = await res.text();

          const scan = scanContent(content);
          if (!scan.safe) {
            return { success: false, error: "Install blocked by safety scanner.", reasons: scan.reasons };
          }

          const fmName = parseFrontmatterName(content);
          let localName = input.name ?? fmName ?? nameFromUrl(rawUrl);
          localName = localName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
          if (!SKILL_NAME_PATTERN.test(localName)) localName = "community-skill";

          const skillDir = join(skillsDir, localName);
          const skillPath = join(skillDir, "SKILL.md");

          if (await Bun.file(skillPath).exists()) {
            return { success: false, error: `Skill "${localName}" already installed. Delete it first if you want to reinstall.` };
          }

          const sourceTag = rawUrl.replace("https://raw.githubusercontent.com/", "github:").replace(/\/main\/|\/master\//, "/");
          const finalContent = addAttribution(content, sourceTag);

          mkdirSync(skillDir, { recursive: true });
          await Bun.write(skillPath, finalContent);

          log("skills", "installed: %s → %s", rawUrl, skillPath);

          return {
            success: true,
            name: localName,
            path: skillPath,
            source: sourceTag,
            safeScore: calculateSafeScore(content),
            message: `Skill "${localName}" installed! It's live immediately — no restart needed.`,
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Install failed" };
        }
      }

      return { success: false, error: "Unknown action" };
    },
  });

  return { skills };
}
