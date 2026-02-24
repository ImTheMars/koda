---
name: deep-research
description: Multi-source parallel research via sub-agents
---

# Deep Research

Conduct thorough multi-source research by spawning parallel sub-agents.

## When to Use

- User asks a complex question requiring multiple perspectives or sources
- User says "research this", "deep dive", or "find out everything about"
- Topic requires cross-referencing multiple sources for accuracy

## Procedure

1. **Decompose the question** into 2-4 independent research angles
2. **Spawn sub-agents** — use spawnAgent for each angle with:
   - Clear, focused task description
   - `tools: ["webSearch", "extractUrl"]` at minimum
   - Relevant context from the user's question
3. **Wait for results** — all sub-agents run concurrently
4. **Synthesize findings**:
   - Cross-reference facts across sources
   - Identify consensus vs. conflicting information
   - Note gaps or areas with limited data
5. **Present the synthesis** — organized by theme, not by source
6. **Store key findings** in memory for follow-up questions

## Guidelines

- Use 2-4 sub-agents — more than 4 rarely adds value
- Give each sub-agent a distinct research angle, not overlapping queries
- Prefer authoritative sources (official docs, research papers, established publications)
- Clearly distinguish facts from opinions and speculation
- Include source attribution for key claims
- If one sub-agent fails, work with what the others found
