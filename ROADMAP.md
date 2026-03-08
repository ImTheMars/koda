# koda — feature status & roadmap

> last updated: 2026-03-08  
> branch: `cursor/open-claw-feature-parity-d269`  
> goal: feature parity with OpenClaw across channels, media, and extensibility — while keeping koda's autonomy layer as a genuine differentiator.

---

## legend

| symbol | meaning |
|--------|---------|
| ✅ | working, production-ready |
| 🟡 | partial — works but with known limitations |
| ❌ | not implemented |
| 🔒 | works but depends on an external API key |
| 🧪 | implemented but not battle-tested |

---

## 1. core agent

| feature | status | notes |
|---------|--------|-------|
| LLM tool loop (generateText) | ✅ | Vercel AI SDK v6, up to 30 steps |
| Streaming responses (streamText) | ✅ | chunked delivery, code-block-aware splitting |
| 2-tier routing (fast / deep) | ✅ | Gemini Flash → Claude Sonnet |
| Mid-request tier escalation | ✅ | auto-escalates after step 5 on fast tier |
| Uncertainty-signal escalation | ✅ | keyword detection in step outputs |
| Model failover chains | ✅ | OpenRouter `models` array, silent fallback |
| Manual tier override (`/deep`, `/fast`) | ✅ | persists for next message only |
| Model switching at runtime (`/model`) | ✅ | persisted to config.json |
| Request tracing (per-request IDs) | ✅ | 8-char prefix in all log lines |
| Circuit breaker (LLM failures) | ✅ | configurable threshold + reset window |
| Token-based history trimming | ✅ | 6000 token budget (~24k chars) |
| Conversation summarization (async) | ✅ | fires every N messages, injected on next turn |
| Follow-up intent detection | ✅ | pattern-based, zero LLM cost |
| Tool outcome learning | ✅ | success/fail logged to SQLite for future context |
| Adaptive model routing (savings meter) | ❌ | OpenClaw shows token savings ledger in UI |

---

## 2. memory

| feature | status | notes |
|---------|--------|-------|
| Semantic memory (store + recall) | 🔒 | Supermemory cloud API — graceful no-op without key |
| LLM-extracted facts from conversation | 🔒 | runs every 3rd ingest call, structured by type |
| Contradiction / update handling | 🔒 | Supermemory `updateMemory` with versioning |
| Memory deduplication | 🔒 | word overlap + normalization |
| Memory consolidation (merge duplicates) | 🔒 | periodic, async |
| Memory deletion (`deleteMemory` tool) | 🔒 | search-based via Supermemory document API |
| `/memories` Telegram command | ✅ | list + delete by query |
| Dashboard memory search | ✅ | `GET /api/memories?q=` + delete |
| Per-user memory (private chats) | 🔒 | `user-{senderId}` Supermemory containers |
| Per-chat project memory (groups) | 🔒 | `project-{chatId}` containers |
| Goal inference from memory extraction | ✅ | extracted facts become structured assessment evidence |
| SQLite fallback when Supermemory absent | ✅ | keyword-based history search |
| Local embeddings (Ollama) | ❌ | removed in v0.11.0 — no local vector search without Supermemory key |
| Knowledge graph memory | ❌ | OpenClaw uses a knowledge graph; koda uses flat vector search |
| Ollama embeddings integration | ❌ | OpenClaw v2026.3.2 added this; koda does not have it |

---

## 3. channels

| channel | status | notes |
|---------|--------|-------|
| **Telegram** | ✅ | full — text, media, voice, groups, commands, streaming |
| **CLI / REPL** | ✅ | local interactive fallback |
| **Discord** | ❌ | — |
| **WhatsApp** | ❌ | — |
| **Slack** | ❌ | — |
| **Signal** | ❌ | — |
| **iMessage** | ❌ | requires macOS BlueBubbles bridge |
| **Microsoft Teams** | ❌ | — |
| **Matrix** | ❌ | — |
| **Mattermost** | ❌ | — |
| **WebChat (in-browser)** | ❌ | dashboard exists but is monitoring-only — no chat UI |
| **LINE / Zalo / Feishu** | ❌ | — |
| **IRC / Twitch / Nostr** | ❌ | — |
| **SMS** | ❌ | OpenClaw does this via Android node |
| Channel adapter abstraction layer | ❌ | Telegram handler is monolithic (~1,462 lines), no shared interface |

---

## 4. telegram (deep-dive)

| feature | status | notes |
|---------|--------|-------|
| Text messages | ✅ | |
| Photo / image input | ✅ | passed as multimodal content to LLM |
| Voice message transcription | ✅ | Gemini Flash via OpenRouter `input_audio` |
| Circle video (video note) transcription | ✅ | same pipeline as voice |
| Document ingestion — PDF | ✅ | `pdf-parse`, truncated at 30k chars |
| Document ingestion — text files | ✅ | .txt, .md, .csv, .json, .html, .xml |
| Reply threading | ✅ | replied-to message passed as context |
| Forwarded message metadata | ✅ | original sender/channel included |
| Edited message handling | ✅ | `[edited]` prefix, new agent response |
| Streaming replies (draft mode) | ✅ | Grammy `sendMessageDraft`, topic-safe |
| Multi-segment fallback delivery | ✅ | falls back to segmented sendMessage if draft unavailable |
| Group chat support | ✅ | passive listening + mention/reply activation |
| @mention activation | ✅ | |
| Name trigger activation ("koda") | ✅ | configurable `botNameTriggers` |
| Message attribution in groups | ✅ | `[DisplayName]: ...` prefix |
| Admin-only commands in groups | ✅ | `/clear`, `/model`, `/adduser`, `/removeuser` |
| Webhook mode | ✅ | with secret verification, retry on boot |
| Polling mode | ✅ | default |
| Startup/shutdown notifications | ✅ | admin Telegram messages |
| Rate limiting | ✅ | per-chat with stale entry sweep every 5min |
| Duplicate message dedup | ✅ | |
| Markdown → Telegram HTML conversion | ✅ | lists, checkboxes, code blocks, bold, italic |
| Voice output (TTS) | ❌ | koda can receive voice, not send it |
| Sending images (generated) | ✅ | image URLs auto-sent as Telegram photos |
| Sending files (`sendFile` tool) | ✅ | workspace files as document attachments |
| Inline file attachments (arbitrary) | ❌ | OpenClaw v2026.3.2 added inline session attachments |
| Telegram DM topic routing | ❌ | OpenClaw added this in v2026.3.2 |
| Video input | ❌ | only audio extracted from circle videos |

---

## 5. voice & audio

| feature | status | notes |
|---------|--------|-------|
| Voice message input (Telegram) | ✅ | transcribed via Gemini Flash |
| Circle video audio (Telegram) | ✅ | same pipeline |
| Audio file transcription (standalone tool) | ❌ | no `transcribeAudio` tool — only works via Telegram handler |
| Voice output / TTS | ❌ | no speech synthesis anywhere in the stack |
| Live voice tab (mobile) | ❌ | requires mobile app |

---

## 6. media & files

| feature | status | notes |
|---------|--------|-------|
| Image input (Telegram photo) | ✅ | multimodal to LLM |
| Image generation | 🔒 | OpenRouter image model (Gemini Pro Image) |
| PDF ingestion | 🟡 | text extraction only via pdf-parse — no vision, no structured extraction |
| PDF as first-class tool | ❌ | OpenClaw has native Anthropic/Google vision-based PDF tool |
| Text file ingestion (.txt, .md, .csv, .json, .html, .xml) | ✅ | |
| File sending to user | ✅ | `sendFile` tool → Telegram document |
| Data analysis (CSV/JSON) | ✅ | `analyzeData` tool — stats, no sandbox needed |
| Outbound media (Discord, Slack, WhatsApp) | ❌ | no cross-channel outbound adapters |

---

## 7. tools

| tool category | status | notes |
|---------------|--------|-------|
| Web search (`webSearch`) | 🔒 | Exa API — graceful fail without key |
| URL extraction (`extractUrl`) | 🔒 | Exa highlights, up to 15k chars |
| HTTP requests (`fetchUrl`, `httpRequest`) | ✅ | |
| Filesystem read/write/list | ✅ | workspace-scoped, path-hardened |
| Code sandbox (`runSandboxed`) | 🟡 | Docker primary, `Bun.spawn` fallback (no Docker on Railway) |
| Memory tools (remember, recall, delete) | 🔒 | Supermemory |
| Project memory tools | 🔒 | group-specific containers |
| Schedule tools (reminder, recurring, list, delete) | ✅ | |
| Skills tool (list/load/create/search/preview/install) | 🔒 | search/install need Exa key |
| Soul tools (get, update) | ✅ | hot-reloaded |
| System status | ✅ | |
| Image generation | 🔒 | OpenRouter |
| Send file | ✅ | |
| Spawn sub-agent | ✅ | |
| Assessment tools (goals, observations, interventions, reviews) | ✅ | 16 tools |
| Planning tools (create, list, get, update, approve, verify) | ✅ | |
| MCP dynamic tools | ✅ | all three transports |
| Composio tools (Gmail, Calendar, GitHub) | 🔒 | requires Composio API key + OAuth |
| Smart home control | ❌ | OpenClaw integrates with home automation |
| Browser automation tool | ❌ | noted in config flag `allowBrowserAutomation` but no implementation |

---

## 8. scheduling & proactive

| feature | status | notes |
|---------|--------|-------|
| One-shot reminders | ✅ | |
| Recurring tasks (cron + natural language) | ✅ | "every Monday at 9am" |
| Near-term precision nudges | ✅ | `setTimeout` for reminders within 5 minutes |
| Boot-time catch-up (30-min grace) | ✅ | |
| Task failure tracking + auto-disable | ✅ | 3 strikes → disable + admin notify |
| Plan step continuation via scheduler | ✅ | proactive tick dispatches next runnable plan step |
| Weekly review seed task | ✅ | auto-seeded on boot |
| Goal drift audit seed task | ✅ | auto-seeded on boot |
| Timezone-aware scheduling | ✅ | IANA timezone, configurable |

---

## 9. autonomy (koda's differentiator)

| feature | status | notes |
|---------|--------|-------|
| Structured goals | ✅ | persisted SQLite, injected into system prompt |
| Observations (evidence tracking) | ✅ | |
| Interventions | ✅ | |
| Reflective reviews | ✅ | |
| Assessment snapshot | ✅ | full state dump to prompt |
| Durable multi-step plans | ✅ | steps, success criteria, verification hints |
| Plan approval workflow | ✅ | configurable risk threshold |
| Outcome verification (`verifyOutcome`) | ✅ | checks files, tasks, plans, URLs |
| Tool governance metadata | ✅ | risk level, reversibility, approval, verification |
| Monthly budget tracking | ✅ | `monthlyBudgetUsd` config |
| Per-plan budget limit | ✅ | `perPlanBudgetUsd` config |
| Max concurrent plans config | ✅ | |
| Browser automation governance flag | ✅ | `allowBrowserAutomation` — controls MCP warning |

---

## 10. sub-agents

| feature | status | notes |
|---------|--------|-------|
| Spawn isolated child agents | ✅ | `spawnAgent` tool |
| Filtered toolsets per child | ✅ | `ALWAYS_BLOCKED` list prevents recursion |
| Live progress streaming (`streamUpdate`) | ✅ | SSE to dashboard |
| Structured result return (`returnResult`) | ✅ | parseable output, not raw text blob |
| Named session registry | ✅ | `@AgentName: ...` routing |
| Kill sub-agent | ✅ | AbortController + dashboard `DELETE /api/spawns` |
| Sub-agent timeout + step config | ✅ | per-spawn or config defaults |
| Sub-agent tier control | ✅ | force fast or deep |
| Sub-agent context passing | ✅ | parent shares relevant conversation context |
| Plan tool access (sub-agents) | ✅ | getPlan, updatePlanStep, verifyOutcome |

---

## 11. dashboard & observability

| feature | status | notes |
|---------|--------|-------|
| Web dashboard (port 3000) | ✅ | dark mode, embedded CSS + JS |
| SSE real-time updates | ✅ | sub-agent activity |
| Usage stats (today / month / all-time) | ✅ | token cost + tool cost |
| Tool cost breakdown | ✅ | tracked separately from LLM cost |
| Sub-agent activity panel | ✅ | live progress lines + kill control |
| Skills management | ✅ | |
| Tasks view | ✅ | |
| Goals view | ✅ | |
| Plans view | ✅ | |
| Memory search | ✅ | |
| Usage CSV export | ✅ | `GET /api/export/usage` |
| In-browser chat UI | ❌ | dashboard is monitoring-only — no conversation interface |
| Token savings meter (routing) | ❌ | no visibility into fast vs deep savings |
| Structured logging (JSON) | 🟡 | `LOG_FORMAT=json` works, but many catch blocks swallow errors silently |
| Metrics / tracing | ❌ | no request IDs propagated everywhere, no Prometheus/OTEL |

---

## 12. infrastructure & deployment

| feature | status | notes |
|---------|--------|-------|
| SQLite WAL (schema v8, 15+ tables) | ✅ | incremental migrations |
| Daily auto-backup (7-day retention) | ✅ | |
| Docker Compose deploy | ✅ | |
| Railway deploy (auto on push) | ✅ | |
| Health check endpoint (`/health`) | ✅ | version + uptime |
| Railway build monitor | ✅ | 60s polling, build/fail notifications |
| SIGTERM vs SIGINT differentiation | ✅ | different user-facing messages |
| Deploy duration measurement | ✅ | shutdown→startup elapsed time in online message |
| Webhook secret enforcement | ✅ | required in webhook mode |
| MCP (stdio, SSE, HTTP) | ✅ | all three transports, auto-reconnect |
| Ollama local LLM (fast tier) | 🟡 | supported in config, not default |
| Plugin SDK | ❌ | no extension system for channels or tools |
| Config validation CLI (`config validate`) | ❌ | `doctor` checks connectivity, not schema |
| Secrets management (SecretRef) | ❌ | basic log redaction only |

---

## 13. mobile & desktop clients

| feature | status | notes |
|---------|--------|-------|
| iOS app (pairing, Canvas, camera, voice) | ❌ | |
| Android app (device commands, contacts, SMS) | ❌ | |
| macOS companion app | ❌ | |
| WebChat (browser-based chat) | ❌ | priority — lowest barrier to entry |
| Screen recording / location / camera | ❌ | requires mobile apps |

---

## 14. integrations

| integration | status | notes |
|-------------|--------|-------|
| OpenRouter | ✅ | all LLM routing |
| Supermemory | 🔒 | semantic memory |
| Exa | 🔒 | web search + skill shop |
| Composio (Gmail, Calendar, GitHub) | 🔒 | OAuth flow, SDK bug workaround in place |
| MCP servers (Notion, Playwright, Spotify, etc.) | ✅ | via config |
| Ollama | 🟡 | fast tier only, no embeddings |
| Smart home (Home Assistant, etc.) | ❌ | |

---

## 15. security

| feature | status | notes |
|---------|--------|-------|
| Path containment (`safePath`) | ✅ | blocks traversal, symlinks, null bytes |
| Blocked sensitive patterns (.env, creds, .ssh, .aws) | ✅ | |
| Prompt sanitization | ✅ | HTML-escapes user content before prompt injection |
| Tool arg redaction in logs | ✅ | removes API keys, tokens, passwords |
| Webhook secret verification | ✅ | |
| Docker sandbox resource limits | ✅ | 512MB RAM, 0.5 CPU, no network |
| Skill safety scanner | ✅ | weighted pattern matching for injections, exfiltration, dangerous shell |
| allowFrom (user allowlist) | ✅ | |
| Admin permission gating | ✅ | group chat commands + user management |
| Secrets management system | ❌ | |
| Rate limiting (per-user) | 🟡 | implemented in Telegram channel, not across all channels |

---

## 16. testing & quality

| feature | status | notes |
|---------|--------|-------|
| Bun unit tests | ✅ | 220 passing, 0 failing |
| Router tests | ✅ | tier classification, intent, cost, ack |
| DB tests | ✅ | all tables, migrations, backup |
| Config tests | ✅ | schema, env overrides, defaults |
| Security tests | ✅ | path blocking, sanitization, redaction |
| Time/cron tests | ✅ | natural language + IANA timezone |
| Group chat tests | ✅ | 34 cases |
| Event bus tests | ✅ | |
| Follow-up detection tests | ✅ | |
| Agent core tests | ❌ | requires live LLM — covered by bench instead |
| Memory provider tests | ❌ | requires Supermemory key |
| Telegram channel tests | ❌ | requires Grammy/bot session |
| Tool unit tests | ❌ | covered by LLM-as-judge bench |
| LLM-as-judge benchmark suite | ✅ | categories: assessment, planning, routing, verification, self-correction |
| TypeScript strict mode (0 errors) | ✅ | `tsc --noEmit` passes |
| 31+ `any` types in source | 🟡 | mostly external API casts — not breaking but noted |
| 30+ silent catch blocks | 🟡 | errors swallowed without logging in several places |

---

## roadmap

### phase 1 — channel foundation (next, critical)

The biggest gap vs OpenClaw is that koda is single-channel. Everything else is secondary.

**1a. Channel adapter abstraction**
- Define `ChannelAdapter` interface: `send()`, `sendPhoto()`, `sendFile()`, `sendAudio()`, `onMessage()`, `start()`, `stop()`
- Define shared `InboundMessage` type (normalizes platform differences)
- Refactor existing Telegram handler into `TelegramAdapter` implementing the interface
- Move channel wiring out of `index.ts` into a channel registry

**1b. Discord adapter**
- `discord.js` v14
- Text channels, DMs, slash commands, mention activation
- Group chat logic (same model as Telegram groups — passive listen + @mention)
- Image, file send support

**1c. WebChat (in-browser chat)**
- Add `/chat` route on existing Bun server (next to the dashboard at `/`)
- SSE for streaming responses (infrastructure already exists)
- Simple HTML/CSS/JS — no framework needed, matches dashboard aesthetic
- Session-based (cookie or URL token)
- Lowers adoption barrier to zero — no app install required

---

### phase 2 — media & voice completeness

**2a. Voice output (TTS)**
- Add a TTS step to the response pipeline
- OpenRouter or direct provider (ElevenLabs, OpenAI TTS, or Kokoro for self-hosted)
- Telegram: send voice note back when user sends voice note
- WebChat: stream audio in-browser

**2b. Audio transcription tool**
- Lift transcription out of the Telegram handler into a standalone `transcribeAudio` tool
- Accept file path or URL
- Re-use from any channel, not just Telegram

**2c. PDF as first-class tool**
- Replace `pdf-parse` text extraction with vision-based extraction
- Pass PDF pages as images to Anthropic/Google vision models
- Support structured extraction (tables, forms, figures)

---

### phase 3 — additional channels

Priority order based on user base size and implementation complexity:

| channel | library | complexity |
|---------|---------|------------|
| WhatsApp | Baileys / WhatsApp Business API | medium-high |
| Slack | Slack Bolt SDK | low |
| Signal | signal-cli bridge | medium |
| Matrix | matrix-js-sdk | medium |
| Mattermost | mattermost-client | low |

---

### phase 4 — extensibility & polish

**4a. Plugin SDK**
- `ChannelPlugin` contract matching OpenClaw's pattern
- Dynamic loading from `~/.koda/extensions/` or npm packages
- Channel + tool plugins
- Semver'd SDK package

**4b. Local embeddings (Ollama)**
- Re-add Ollama embeddings for local vector search
- Use when Supermemory key is absent — better than keyword fallback
- Hybrid: local embeddings for recall speed, Supermemory for persistence

**4c. Token savings meter**
- Track fast vs deep tier usage per request
- Show "saved $X by using fast tier" in dashboard
- Weekly savings summary in `/usage`

**4d. Config validation CLI**
- `bun koda config validate` — strict schema check against Zod, friendly error messages
- Separate from `doctor` (which checks connectivity)

**4e. Secrets management**
- `SecretRef` support: reference credentials by name rather than embedding values in config
- Integrate with Railway secrets, env vars, or local `.secrets` file
- Log redaction coverage expanded to 64+ known credential patterns

**4f. Error handling hardening**
- Audit 30+ silent catch blocks and add structured error logging
- Add `logError(tag, err)` callsites where errors are currently swallowed
- Especially: proactive scheduler, memory consolidation, boot phases

---

### phase 5 — mobile (long horizon)

- WebChat stability and PWA support first (zero install on mobile via browser)
- iOS app: pairing, voice tab, camera — likely React Native or Swift
- Android app: device commands, contacts/calendar, SMS, notifications
- macOS companion app

---

## what we do better than openclaw

| capability | koda | openclaw |
|------------|------|---------|
| Structured assessment state | ✅ goals, observations, interventions, reviews | ❌ |
| Durable multi-step plans with verification | ✅ | ❌ |
| Goal drift audit (reflective protocol) | ✅ weekly auto-seeded | ❌ |
| Plan step continuation via scheduler | ✅ | ❌ |
| Tool governance + approval thresholds | ✅ | ❌ |
| Monthly/per-plan budget controls | ✅ | ❌ |
| Railway deploy monitoring | ✅ | ❌ |
| LLM-as-judge benchmark suite | ✅ | ❌ |
| Sub-agent named session routing | ✅ `@AgentName: ...` | ❌ |

The autonomy layer — knowing the user, tracking evidence, running durable plans, verifying outcomes — is koda's genuine differentiator. OpenClaw is primarily a multi-channel routing layer. Keep this.

---

## quick gap summary (koda vs openclaw today)

| gap | priority | effort |
|-----|----------|--------|
| Channel adapter abstraction | P0 | medium |
| Discord | P0 | medium |
| WebChat (in-browser chat) | P0 | low |
| Voice output / TTS | P1 | low-medium |
| WhatsApp | P1 | high |
| Audio transcription tool | P1 | low |
| PDF vision extraction | P1 | low |
| Slack | P2 | low |
| Local embeddings (Ollama) | P2 | low |
| Token savings meter | P2 | low |
| Config validation CLI | P2 | low |
| Plugin SDK | P3 | high |
| Signal / Matrix / Mattermost | P3 | medium |
| Secrets management | P3 | medium |
| iOS / Android apps | P4 | very high |
| Smart home | P4 | medium |
| Knowledge graph memory | P4 | very high |
