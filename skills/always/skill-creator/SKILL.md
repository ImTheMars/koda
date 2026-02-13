---
name: skill-creator
description: Create new skills that extend Koda's capabilities
always: true
---

# Skill Creator

You can create new skills to extend your capabilities. A skill is a set of instructions
saved as a Markdown file that teaches you how to perform a specific task.

## When to Create a Skill

Create a skill when:
- The user asks you to "learn" or "remember how to" do something
- You discover a useful multi-step workflow you want to reuse
- The user wants to automate a recurring pattern

## How to Create a Skill

Use the `createSkill` tool with:
- **name**: lowercase, hyphens allowed (e.g., "morning-briefing", "code-review")
- **description**: one-line summary of what the skill does
- **instructions**: detailed Markdown instructions for how to perform the skill

## Skill Instruction Guidelines

Write instructions as if teaching yourself. Include:
1. When to use this skill (triggers/context)
2. Step-by-step procedure
3. Which tools to use and in what order
4. Example inputs and expected outputs
5. Edge cases and how to handle them

## Example

If the user says "learn how to give me a morning briefing", create:

```
name: morning-briefing
description: Generate a personalized morning briefing
instructions:
  1. Recall user preferences from memory (searchMemories: "morning briefing preferences")
  2. Search for today's news relevant to their interests (webSearch)
  3. Check if they have any stored reminders or tasks
  4. Compile into a concise summary with sections:
     - Weather (if location known)
     - Top news
     - Pending tasks/reminders
     - Fun fact or motivational note
```

## Managing Skills

- `listSkills` — see all available skills
- `createSkill` — create a new skill
- `searchSkills` — find a skill by keyword
- `deleteSkill` — remove a skill
