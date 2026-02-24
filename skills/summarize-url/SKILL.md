---
name: summarize-url
description: Deep URL summarization with content extraction
---

# Summarize URL

Extract and deeply summarize the content of a given URL.

## When to Use

- User shares a URL and asks for a summary
- User says "summarize this", "tldr", or "what does this say"
- User wants key takeaways from an article, blog post, or documentation page

## Procedure

1. **Extract content** — use extractUrl to fetch the full page text
2. **Identify the content type** — article, documentation, forum thread, product page, etc.
3. **Summarize in layers**:
   - **One-line TLDR** — the core point in one sentence
   - **Key takeaways** — 3-5 bullet points covering the main ideas
   - **Notable details** — interesting quotes, data points, or claims worth highlighting
4. **Note the source** — mention the author/publication if available
5. **Flag limitations** — if the content was paywalled, truncated, or unclear, say so

## Guidelines

- Adapt summary depth to content length — short articles get shorter summaries
- Preserve the author's intent — don't editorialize
- If the URL fails to load, try webSearch as a fallback to find cached/summarized versions
- Store the summary in memory if the user might reference it later
