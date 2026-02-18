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
export type RelationType = "prefers" | "knows" | "updated_from" | "part_of" | "contradicts" | "co_occurs";

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

/** Persist extracted entities and link them to a memory record, plus wire entity-to-entity edges. */
export function linkEntitiesToMemory(
  userId: string,
  memoryId: string,
  extracted: ExtractedEntity[],
): void {
  const savedIds: string[] = [];

  for (const ent of extracted) {
    const id = `ent_${userId}_${ent.type}_${ent.name.toLowerCase().replace(/\W+/g, "_")}`;
    const finalId = dbEntities.upsert({
      id,
      userId,
      type: ent.type,
      name: ent.name,
      attributes: ent.attributes ? JSON.stringify(ent.attributes) : null,
    });

    // Entity → memory link
    const relId = `rel_${finalId}_${memoryId}`;
    dbRelations.insert({
      id: relId,
      fromEntity: finalId,
      toEntity: null,
      toMemory: memoryId,
      relation: "part_of",
    });

    savedIds.push(finalId);
  }

  // Entity → entity edges: every pair that appears in the same memory
  for (let i = 0; i < savedIds.length; i++) {
    for (let j = i + 1; j < savedIds.length; j++) {
      const a = savedIds[i];
      const b = savedIds[j];
      const aEnt = extracted[i];
      const bEnt = extracted[j];

      // Pick a meaningful relation based on entity types
      let relation: RelationType = "co_occurs";
      if (aEnt.type === "person" && bEnt.type === "person") relation = "knows";
      else if (aEnt.type === "person" && bEnt.type === "preference") relation = "prefers";
      else if (bEnt.type === "person" && aEnt.type === "preference") relation = "prefers";
      else if (aEnt.type === "topic" && bEnt.type === "project") relation = "part_of";
      else if (bEnt.type === "topic" && aEnt.type === "project") relation = "part_of";

      const edgeId = `rel_co_${a.slice(-8)}_${b.slice(-8)}`;
      dbRelations.insert({ id: edgeId, fromEntity: a, toEntity: b, toMemory: null, relation });

      const edgeIdRev = `rel_co_${b.slice(-8)}_${a.slice(-8)}`;
      dbRelations.insert({ id: edgeIdRev, fromEntity: b, toEntity: a, toMemory: null, relation });
    }
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

/** Fuzzy-merge near-duplicate entities (e.g. "box combo" vs "raising cane's box combo"). */
export function mergeNearDuplicateEntities(userId: string): number {
  const ents = dbEntities.listByUser(userId);
  if (ents.length < 2) return 0;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();

  // Group by type so we only compare within same type
  const byType = new Map<string, typeof ents>();
  for (const e of ents) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }

  let merged = 0;
  const absorbed = new Set<string>();

  for (const [, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      if (absorbed.has(group[i]!.id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (absorbed.has(group[j]!.id)) continue;
        const a = normalize(group[i]!.name);
        const b = normalize(group[j]!.name);

        // One contains the other → merge shorter into longer
        if (a.includes(b) || b.includes(a)) {
          const keep = a.length >= b.length ? group[i]! : group[j]!;
          const drop = a.length >= b.length ? group[j]! : group[i]!;

          // Re-point all relations from drop → keep
          const rels = dbRelations.listFromEntity(drop.id);
          for (const r of rels) {
            const newId = `rel_merge_${keep.id.slice(-8)}_${r.id.slice(-8)}`;
            dbRelations.insert({
              id: newId,
              fromEntity: keep.id,
              toEntity: r.toEntity,
              toMemory: r.toMemory,
              relation: r.relation,
            });
          }

          // Delete the dropped entity (soft: just re-point, keep the row for now)
          absorbed.add(drop.id);
          merged++;
          log("graph", "merged entity '%s' into '%s'", drop.name, keep.name);
        }
      }
    }
  }

  return merged;
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
