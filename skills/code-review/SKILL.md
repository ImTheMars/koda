---
name: code-review
description: Structured code review from file or pasted snippet
---

# Code Review

Perform a structured code review on a file or pasted code snippet.

## When to Use

- User shares a code snippet or file and asks for review
- User asks "review this", "what's wrong with this code", or "how can I improve this"
- User sends a file and wants feedback

## Procedure

1. **Read the code** — if a file path is given, use readFile to load it. If pasted inline, work with what's provided.
2. **Analyze** for these categories:
   - **Bugs & logic errors** — incorrect behavior, off-by-one, null refs, race conditions
   - **Security** — injection, auth issues, exposed secrets, unsafe patterns
   - **Performance** — unnecessary allocations, O(n²) where O(n) works, missing caching
   - **Readability** — naming, structure, dead code, overly complex logic
   - **Best practices** — error handling, typing, edge cases, test coverage gaps
3. **Prioritize findings** — lead with the most impactful issues
4. **Suggest fixes** — for each issue, show the improved code or describe the fix
5. **Summarize** — end with a brief overall assessment (1-2 sentences)

## Guidelines

- Be specific — reference line numbers or function names
- Don't nitpick style unless it hurts readability
- Acknowledge what's done well, not just what's wrong
- If the code is solid, say so — don't invent issues
- Keep the tone constructive, not condescending
