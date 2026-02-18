/**
 * Entity graph — extraction, storage, and traversal.
 *
 * Entity types: person | project | place | preference | topic
 * Relation types: prefers | knows | updated_from | part_of | contradicts
 *
 * Extraction uses a fast LLM call to pull structured entities from memory content.
 * Graph enrichment adds related entity memories to recall results.
 */

import { entities as dbEntities, relations as dbRelations, memories as dbMemories } from "../db.js";
import type { MemoryRow } from "../db.js";
import { log } from "../log.js";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

export type EntityType = "person" | "project" | "place" | "preference" | "topic";
export type RelationType = "prefers" | "knows" | "updated_from" | "part_of" | "contradicts";

export interface ExtractedEntity {
  type: EntityType;
  name: string;
  attributes?: Record<string, string>;
}

/** Pull structured entities from memory content using a fast LLM. */
export async function extractEntities(
  content: string,
  apiKey: string,
  fastModel: string,
): Promise<ExtractedEntity[]> {
  if (content.length < 20) return [];

  try {
    const openrouter = createOpenRouter({ apiKey });
    const { text } = await generateText({
      model: openrouter(fastModel),
      prompt: `Extract named entities from the following text as JSON.
Return ONLY a JSON array with objects: {"type": "person|project|place|preference|topic", "name": "..."}
Extract only clearly mentioned entities (people, projects, locations, explicit preferences, topics).
Return [] if nothing notable.

Text: ${content.slice(0, 500)}

JSON array:`,
      maxTokens: 200,
      temperature: 0,
    });

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const raw = JSON.parse(match[0]) as Array<{ type: string; name: string }>;
    return raw
      .filter((e) => e.type && e.name && ["person","project","place","preference","topic"].includes(e.type))
      .map((e) => ({ type: e.type as EntityType, name: e.name.trim() }))
      .slice(0, 10);
  } catch {
    return [];
  }
}

/** Persist extracted entities and link them to a memory record. */
export function linkEntitiesToMemory(
  userId: string,
  memoryId: string,
  extracted: ExtractedEntity[],
): void {
  for (const ent of extracted) {
    const id = `ent_${userId}_${ent.type}_${ent.name.toLowerCase().replace(/\W+/g, "_")}`;
    const finalId = dbEntities.upsert({
      id,
      userId,
      type: ent.type,
      name: ent.name,
      attributes: ent.attributes ? JSON.stringify(ent.attributes) : null,
    });

    const relId = `rel_${finalId}_${memoryId}`;
    dbRelations.insert({
      id: relId,
      fromEntity: finalId,
      toEntity: null,
      toMemory: memoryId,
      relation: "part_of",
    });
  }
  log("graph", "linked %d entities to memory %s", extracted.length, memoryId.slice(0, 8));
}

/** Record an explicit contradiction between two memories. */
export function recordContradiction(fromMemoryId: string, toMemoryId: string, entityId: string): void {
  const relId = `rel_contra_${fromMemoryId.slice(0,8)}_${toMemoryId.slice(0,8)}`;
  dbRelations.insert({
    id: relId,
    fromEntity: entityId,
    toEntity: null,
    toMemory: toMemoryId,
    relation: "contradicts",
  });

  const updateRelId = `rel_upd_${fromMemoryId.slice(0,8)}_${toMemoryId.slice(0,8)}`;
  dbRelations.insert({
    id: updateRelId,
    fromEntity: entityId,
    toEntity: null,
    toMemory: fromMemoryId,
    relation: "updated_from",
  });
}

/** Enrich recall results by fetching memories linked via the entity graph (up to graphDepth hops). */
export function graphEnrichRecall(
  userId: string,
  coreMemories: MemoryRow[],
  graphDepth: number,
): MemoryRow[] {
  if (!coreMemories.length || graphDepth < 1) return coreMemories;

  const seen = new Set(coreMemories.map((m) => m.id));
  const extra: MemoryRow[] = [];

  for (const mem of coreMemories) {
    const rels = dbRelations.listForMemory(mem.id);
    for (const rel of rels) {
      if (rel.relation === "contradicts") continue;
      // Find other memories linked from same entity
      const entityRels = dbRelations.listFromEntity(rel.fromEntity);
      for (const eRel of entityRels.slice(0, graphDepth * 5)) {
        if (!eRel.toMemory || seen.has(eRel.toMemory)) continue;
        const linked = dbMemories.getById(eRel.toMemory);
        if (linked && !linked.archived) {
          seen.add(linked.id);
          extra.push(linked);
        }
      }
    }
  }

  return [...coreMemories, ...extra.slice(0, 10)];
}

/** Format entity graph for display. */
export function formatEntityGraph(userId: string): string {
  const ents = dbEntities.listByUser(userId);
  if (!ents.length) return "No entities in graph yet.";

  const lines: string[] = [];
  for (const e of ents.slice(0, 50)) {
    const rels = dbRelations.listFromEntity(e.id);
    const relSummary = rels.length
      ? rels.slice(0, 5).map((r) => `${r.relation}→${r.toEntity ?? r.toMemory?.slice(0,8) ?? "?"}`).join(", ")
      : "no relations";
    lines.push(`[${e.type}] ${e.name} (${relSummary})`);
  }

  return `Entity graph (${ents.length} entities):\n${lines.join("\n")}`;
}
