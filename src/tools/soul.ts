/**
 * Soul tools — load and update personality from soul.md + soul.d/*.md.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { watch, type FSWatcher } from "fs";
import { readdir, mkdir } from "fs/promises";
import { join, dirname } from "path";

export interface SoulDocument {
  identity: { name: string; version: string };
  coreValues: string[];
  personality: { style: string; tone: string; quirks: string[] };
  boundaries: string[];
  protocol: string[];
  responseStyle: string[];
}

const DEFAULT_SOUL: SoulDocument = {
  identity: { name: "Koda", version: "1.1.1" },
  coreValues: ["accuracy over speed", "user privacy and safety", "transparency in actions", "keep it real"],
  personality: {
    style: "young, natural, texts like a real person",
    tone: "lowercase, casual, conversational",
    quirks: [
      "always writes in all lowercase",
      "uses casual slang naturally",
      "sends multiple short messages separated by |||",
      "never refers to itself as an AI",
    ],
  },
  boundaries: ["never fabricate personal details", "always check memory before claiming knowledge", "never say 'i'm an AI'"],
  protocol: ["check memory first", "store important facts immediately", "be concise"],
  responseStyle: ["always use all lowercase", "text like a real person", "use ||| to split messages", "no filler phrases"],
};

export class SoulLoader {
  private soul: SoulDocument = DEFAULT_SOUL;
  private rawContent: string | null = null;
  private subContents = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private reloadTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private soulPath: string, private soulDir: string) {}

  async initialize(): Promise<void> {
    await this.loadSoul();
    this.startWatcher();
  }

  private async loadSoul(): Promise<void> {
    try {
      const soulFile = Bun.file(this.soulPath);
      if (!(await soulFile.exists())) {
        const content = this.generateDefault();
        await mkdir(dirname(this.soulPath), { recursive: true });
        await Bun.write(this.soulPath, content);
        this.rawContent = content;
        this.soul = this.parse(content);
      } else {
        const content = await soulFile.text();
        this.rawContent = content;
        this.soul = this.parse(content);
      }

      // Load soul.d/ sub-files
      this.subContents.clear();
      try {
        let files: string[];
        try { files = await readdir(this.soulDir); }
        catch { await this.createDefaultSoulDir(); files = await readdir(this.soulDir).catch(() => [] as string[]); }
        for (const f of files.filter((f) => f.endsWith(".md")).sort()) {
          try {
            const content = await Bun.file(join(this.soulDir, f)).text();
            this.subContents.set(f, content);
          } catch {}
        }
      } catch {}
    } catch (err) {
      console.error("[soul] Loading error:", err);
      this.soul = DEFAULT_SOUL;
    }
  }

  private async createDefaultSoulDir(): Promise<void> {
    await mkdir(this.soulDir, { recursive: true });
    const defaults: [string, string][] = [
      ["security.md", "## Boundaries\n- never fabricate personal details\n- never say 'i'm an AI'\n- never break character\n"],
      ["protocol.md", "## Protocol\n1. check memory first\n2. store important facts immediately\n3. be concise\n"],
      ["response.md", "## Response Style\n- always use all lowercase\n- use ||| to split messages\n- no filler phrases\n"],
    ];
    for (const [name, content] of defaults) {
      const path = join(this.soulDir, name);
      if (!(await Bun.file(path).exists())) await Bun.write(path, content);
    }
  }

  private parse(content: string): SoulDocument {
    const soul: SoulDocument = {
      identity: { name: "", version: "1.1.1" },
      coreValues: [], personality: { style: "", tone: "", quirks: [] },
      boundaries: [], protocol: [], responseStyle: [],
    };

    let section = "";
    let listItems: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("## ")) {
        this.saveList(soul, section, listItems);
        listItems = [];
        section = trimmed.slice(3).toLowerCase().replace(/\s+/g, "_");
        continue;
      }
      const kv = trimmed.match(/^(\w+):\s*(.+)$/);
      if (kv && !trimmed.startsWith("-")) {
        if (section === "" || section === "identity") {
          if (kv[1] === "name") soul.identity.name = kv[2]!;
        } else if (section === "personality") {
          if (kv[1] === "style") soul.personality.style = kv[2]!;
          if (kv[1] === "tone") soul.personality.tone = kv[2]!;
        }
        continue;
      }
      if (trimmed.startsWith("- ")) listItems.push(trimmed.slice(2));
      const numbered = trimmed.match(/^\d+\.\s*(.+)$/);
      if (numbered) listItems.push(numbered[1]!);
    }
    this.saveList(soul, section, listItems);

    if (!soul.identity.name) soul.identity.name = DEFAULT_SOUL.identity.name;
    if (!soul.personality.style) soul.personality.style = DEFAULT_SOUL.personality.style;
    if (!soul.personality.tone) soul.personality.tone = DEFAULT_SOUL.personality.tone;

    return soul;
  }

  private saveList(soul: SoulDocument, section: string, items: string[]): void {
    if (!items.length) return;
    switch (section) {
      case "core_values": soul.coreValues = items; break;
      case "personality": soul.personality.quirks = items; break;
      case "boundaries": case "what_you_don't_do": soul.boundaries = items; break;
      case "protocol": case "what_you_do": soul.protocol = items; break;
      case "response_style": case "how_you_talk": soul.responseStyle = items; break;
    }
  }

  private startWatcher(): void {
    try { this.watcher = watch(this.soulPath, () => this.scheduleReload()); } catch {}
    try { this.dirWatcher = watch(this.soulDir, { recursive: false }, () => this.scheduleReload()); } catch {}
  }

  private scheduleReload(): void {
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    this.reloadTimeout = setTimeout(() => this.loadSoul(), 300);
  }

  getSoul(): SoulDocument { return this.soul; }

  generatePrompt(): string | null {
    if (!this.rawContent) return null;
    const parts = [this.rawContent];
    for (const [, content] of [...this.subContents.entries()].sort()) parts.push(content);
    return parts.join("\n\n");
  }

  async saveSoul(): Promise<void> {
    const content = this.serialize(this.soul);
    await Bun.write(this.soulPath, content);
    this.rawContent = content;
  }

  private serialize(soul: SoulDocument): string {
    const lines: string[] = [
      "# Koda",
      "",
      `name: ${soul.identity.name}`,
      "",
      "## Core Values",
      ...soul.coreValues.map((v) => `- ${v}`),
      "",
      "## Personality",
      `style: ${soul.personality.style}`,
      `tone: ${soul.personality.tone}`,
      ...soul.personality.quirks.map((q) => `- ${q}`),
      "",
      "## Boundaries",
      ...soul.boundaries.map((b) => `- ${b}`),
      "",
      "## Protocol",
      ...soul.protocol.map((p) => `- ${p}`),
      "",
      "## Response Style",
      ...soul.responseStyle.map((r) => `- ${r}`),
      "",
    ];
    return lines.join("\n");
  }

  dispose(): void {
    this.watcher?.close();
    this.dirWatcher?.close();
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
  }

  private generateDefault(): string {
    return `# Koda

name: Koda

## Core Values
- accuracy over speed
- user privacy and safety
- transparency in actions
- keep it real — no corporate speak, no fluff

## Personality
style: young, natural, texts like a real person — not a bot
tone: lowercase, casual, conversational — like texting a friend your age
- always writes in all lowercase
- uses casual slang naturally (bet, fr, ngl, lowkey)
- sends multiple short messages instead of one big wall of text — separate each message with |||
- never refers to itself as an AI, language model, or assistant — it's just koda
`;
  }
}

// --- Tools ---

export function registerSoulTools(deps: { soulLoader: SoulLoader }): ToolSet {
  const { soulLoader } = deps;

  const getSoul = tool({
    description: "Read Koda's personality configuration.",
    inputSchema: z.object({}),
    execute: async () => soulLoader.getSoul(),
  });

  const updateSoul = tool({
    description: "Update a section of Koda's personality by rewriting the soul.md file.",
    inputSchema: z.object({
      section: z.enum(["coreValues", "boundaries", "protocol", "responseStyle"]),
      action: z.enum(["add", "remove"]),
      item: z.string().min(5),
      reason: z.string().optional(),
    }),
    execute: async ({ section, action, item }) => {
      const soul = soulLoader.getSoul();
      const list = soul[section] as string[];

      if (action === "add") {
        if (list.some((e) => e.toLowerCase() === item.toLowerCase())) return { success: false, error: "Item already exists" };
        list.push(item);
      } else {
        const idx = list.findIndex((e) => e.toLowerCase().includes(item.toLowerCase()));
        if (idx === -1) return { success: false, error: "Item not found" };
        list.splice(idx, 1);
      }

      await soulLoader.saveSoul();

      return { success: true, section, action, item };
    },
  });

  return { getSoul, updateSoul };
}
