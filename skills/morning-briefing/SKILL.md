---
name: morning-briefing
description: On-demand morning briefing with tasks, schedule, and weather
---

# Morning Briefing

Assemble a concise daily briefing when the user asks for it.

## When to Use

- User asks for a "morning briefing", "daily briefing", or "what's on my plate"
- A scheduled task fires with a briefing prompt

## Procedure

1. **Read HEARTBEAT.md** using readFile to get pending tasks
2. **List scheduled tasks** using listTasks for upcoming reminders
3. **Recall context** using searchMemories with queries like "plans", "goals", "priorities"
4. **Get weather** using webSearch for the user's local weather forecast
5. **Assemble the briefing** in this format:

```
good morning! here's your briefing.

tasks:
- [pending items from HEARTBEAT.md]

upcoming:
- [next reminders and scheduled tasks]

weather:
- [brief forecast]

[optional: anything relevant from memory]
```

## Guidelines

- Keep it short and scannable
- Skip sections that have no content (don't say "no tasks" if there are none, just omit)
- Use the current time from your system prompt for context (morning vs afternoon vs evening)
- If it's not morning, adjust the greeting ("good afternoon", "good evening")
- Don't search for news unless the user specifically asks
