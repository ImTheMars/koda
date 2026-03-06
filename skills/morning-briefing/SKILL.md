---
name: morning-briefing
description: On-demand briefing with goals, schedule, and active plans
---

# Morning Briefing

Assemble a concise daily briefing that surfaces what matters most today.

## When to Use

- User asks for a "morning briefing", "daily briefing", or "what's on my plate"
- A scheduled task fires with a briefing prompt

## Procedure

1. **Inspect structured state** using `assessmentSnapshot`, `listGoals`, and `listPlans`
2. **List scheduled tasks** using `listTasks` for upcoming reminders and recurring work
3. **Recall context** using `recall` if you need recent personal context that is not in the structured state
4. **Use webSearch only if the user explicitly wants live context** like weather or news
5. **Assemble the briefing** in this format:

```
good morning. here's the real picture for today.

focus:
- [top goals, critical plans, or overdue follow-through]

upcoming:
- [next reminders and scheduled tasks]

[optional: one pattern or risk to watch today]
```

## Guidelines

- Keep it short and scannable
- Skip sections that have no content (don't say "no tasks" if there are none, just omit)
- Use the current time from your system prompt for context (morning vs afternoon vs evening)
- If it's not morning, adjust the greeting ("good afternoon", "good evening")
- Don't search for news unless the user specifically asks
- Prefer the most important constraint, risk, or leverage point over a generic motivational message
