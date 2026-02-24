---
name: task-breakdown
description: Decompose goals into actionable scheduled subtasks
---

# Task Breakdown

Break down a large goal into concrete, schedulable subtasks.

## When to Use

- User describes a multi-step goal or project
- User says "help me plan", "break this down", or "how should I approach this"
- User wants accountability for a goal over days or weeks

## Procedure

1. **Understand the goal** — ask clarifying questions if the scope is unclear
2. **Decompose into subtasks** — each should be:
   - Specific and actionable (starts with a verb)
   - Completable in one sitting (30 min to 2 hours)
   - Independently meaningful — delivers visible progress
3. **Order by dependency** — what must happen first? what can be parallel?
4. **Suggest a schedule** — map subtasks to reasonable dates/times based on:
   - User's timezone and typical availability
   - Logical ordering and dependencies
   - Buffer time between related tasks
5. **Offer to schedule** — ask if the user wants reminders created for each subtask
6. **If confirmed**, use createReminder or createRecurringTask for each one

## Guidelines

- Keep subtask count reasonable — 3-8 for most goals, up to 12 for large projects
- Front-load the hardest or most uncertain tasks
- Include a "review progress" check-in task at the midpoint for longer plans
- Don't over-schedule — leave breathing room
- Adapt granularity to the user's experience level with the topic
