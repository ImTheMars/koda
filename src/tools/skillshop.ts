/**
 * Skill Shop — search skills.sh, preview, and install community SKILL.md files.
 *
 * Search: Exa targets skills.sh + GitHub SKILL.md files.
 * Preview: fetches raw SKILL.md from raw.githubusercontent.com (no auth needed).
 * Install: safety scan → write to ~/.koda/skills/<name>/SKILL.md → SkillLoader hot-reload picks it up.
 */

import Exa from "exa-js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { mkdirSync } from "fs";
import { join } from "path";
import { log } from "../log.js";

// --- Safety scanner ---

const MAX_SKILL_SIZE_BYTES = 100_000;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

interface ScanResult {
  safe: boolean;
  reasons: string[];
}

/** Weighted per-pattern severity for safe score calculation */
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

/**
 * Converts a github.com blob URL to a raw.githubusercontent.com URL.
 * e.g. https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md
 *   →  https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best-practices/SKILL.md
 */
function toRawUrl(url: string): string | null {
  // Already a raw URL
  if (url.includes("raw.githubusercontent.com")) return url;

  const match = url.match(
    /https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)/,
  );
  if (!match) return null;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
}

/**
 * Given any GitHub URL in the result, try to locate the SKILL.md raw URL.
 * Handles: repo root, skills/ subdir, arbitrary paths.
 */
function deriveSkillMdUrl(url: string): string | null {
  // If the URL already points at SKILL.md, just convert
  if (url.includes("SKILL.md")) return toRawUrl(url);

  // If it's a github.com URL pointing to a directory or repo, try appending /SKILL.md
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

/** Extract a human-readable skill name from a GitHub URL */
function nameFromUrl(url: string): string {
  const parts = url.replace(/\/$/, "").split("/");
  // Prefer the last meaningful path segment
  const last = parts[parts.length - 1] ?? "";
  if (last && last !== "SKILL.md" && SKILL_NAME_PATTERN.test(last)) return last;
  const second = parts[parts.length - 2] ?? "";
  if (second && SKILL_NAME_PATTERN.test(second)) return second;
  // Fall back to repo name
  const repoIdx = url.includes("github.com") ? url.indexOf("github.com") : -1;
  if (repoIdx !== -1) {
    const repoSlug = url.slice(repoIdx).split("/")[2] ?? "skill";
    return repoSlug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  }
  return "skill";
}

/** Parse the name field from SKILL.md frontmatter (if present) */
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

/** Inject source attribution into SKILL.md frontmatter */
function addAttribution(content: string, source: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (content.startsWith("---")) {
    return content.replace("---\n", `---\nsource: ${source}\ninstalled_at: ${today}\n`);
  }
  return `---\nsource: ${source}\ninstalled_at: ${today}\n---\n\n${content}`;
}

// --- Tool registration ---

export function registerSkillShopTools(deps: { exaApiKey: string; workspace: string; githubToken?: string }): ToolSet {
  const exa = new Exa(deps.exaApiKey);
  const skillsDir = join(deps.workspace, "skills");

  // Build GitHub fetch headers — token bumps rate limit from 60 to 5000 req/hr.
  const ghHeaders: Record<string, string> = { "User-Agent": "koda-skillshop/1.0" };
  if (deps.githubToken) ghHeaders["Authorization"] = `Bearer ${deps.githubToken}`;

  const skillShop = tool({
    description:
      "Browse and install skills from the skills.sh community registry (GitHub-hosted SKILL.md files). " +
      "Actions: search (find skills by topic), preview (read a skill before installing), install (download + save to workspace).",
    inputSchema: z.discriminatedUnion("action", [
      z.object({
        action: z.literal("search"),
        query: z.string().describe("What kind of skill you're looking for, e.g. 'Spotify', 'morning briefing', 'email'"),
      }),
      z.object({
        action: z.literal("preview"),
        rawUrl: z.string().url().describe("Raw GitHub URL to the SKILL.md file to preview"),
      }),
      z.object({
        action: z.literal("install"),
        rawUrl: z.string().url().describe("Raw GitHub URL to the SKILL.md to install"),
        name: z.string().optional().describe("Local name for the skill (auto-detected from file if omitted)"),
      }),
    ]),

    execute: async (input) => {
      // --- SEARCH ---
      if (input.action === "search") {
        log("skillshop", "search: %s", input.query);
        try {
          const result = await exa.searchAndContents(
            `${input.query} skill SKILL.md agent site:github.com OR site:skills.sh`,
            {
              type: "auto",
              numResults: 8,
              highlights: { maxCharacters: 500 },
            },
          );

          const skills = result.results
            .filter((r) => {
              const u = r.url.toLowerCase();
              return u.includes("github.com") || u.includes("skills.sh");
            })
            .map((r, i) => {
              const skillMdUrl = deriveSkillMdUrl(r.url);
              const rawUrl = skillMdUrl ?? r.url;
              const name = nameFromUrl(r.url);
              const snippet = ((r as any).highlights ?? [])[0] ?? (r.title ?? "");
              return {
                index: i + 1,
                name,
                title: r.title ?? name,
                description: snippet,
                githubUrl: r.url,
                rawUrl,
              };
            });

          return {
            success: skills.length > 0,
            query: input.query,
            results: skills,
            count: skills.length,
            tip: skills.length > 0
              ? `To install, say: skillShop install with rawUrl="${skills[0]?.rawUrl}"`
              : "Try a different search term.",
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Search failed", results: [] };
        }
      }

      // --- PREVIEW ---
      if (input.action === "preview") {
        log("skillshop", "preview: %s", input.rawUrl);
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
        log("skillshop", "install: %s", input.rawUrl);
        const rawUrl = toRawUrl(input.rawUrl) ?? input.rawUrl;
        try {
          const res = await fetch(rawUrl, { headers: ghHeaders });
          if (!res.ok) return { success: false, error: `HTTP ${res.status} fetching ${rawUrl}` };
          const content = await res.text();

          const scan = scanContent(content);
          if (!scan.safe) {
            return {
              success: false,
              error: "Install blocked by safety scanner.",
              reasons: scan.reasons,
            };
          }

          const fmName = parseFrontmatterName(content);
          let localName = input.name ?? fmName ?? nameFromUrl(rawUrl);
          // Sanitize to valid name
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

          log("skillshop", "installed: %s → %s", rawUrl, skillPath);

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
    },
  });

  return { skillShop };
}
