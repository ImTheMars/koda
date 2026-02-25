# changelog

all notable changes to koda.

---

## 2026-02-24
### v1.0.0 — Koda 1.0

the 1.0 release. four incremental releases (v0.13–v0.16) shipped as one tag. composio integrations for email/calendar/github, smarter memory, follow-up detection, bootstrap split, structured logging, and polish across the board.

#### v0.13 — Email + Calendar + Daily Briefing (via Composio)

- **composio integration** (`src/composio.ts`) — thin wrapper around Composio SDK. manages per-user OAuth connections and exposes Vercel AI SDK-compatible tools for Gmail, Google Calendar, and GitHub.
- **composio config** — `composio.apiKey` config section + `KODA_COMPOSIO_API_KEY` env override.
- **`koda setup composio`** — CLI wizard to set API key + initiate OAuth for Gmail, Calendar, GitHub. opens browser for authorization.
- **composio doctor check** — `koda doctor` verifies Composio key and connected apps.
- **oauth callback** — `/oauth/callback` route shows success/fail page after Composio OAuth exchange.
- **composio tool registration** — Gmail, Calendar, GitHub tools auto-register when connected. tools merge directly into agent's ToolSet.
- **daily briefing seed task** — recurring 8AM task summarizing calendar, emails, and pending tasks. only seeded when Composio is configured.

#### v0.14 — Memory Intelligence + Proactive

- **smarter memory ingestion** — LLM-powered fact extraction via fast model. extracts structured facts (preference, personal, project, decision, action, opinion) with confidence scores. runs every 3rd ingestion call per session. deduplicates against existing facts using normalization, substring containment, and word overlap.
- **`deleteMemory` tool** — search-based memory deletion via Supermemory document API.
- **`/memories` command** — Telegram command to list recent memories or delete specific ones (`/memories delete <query>`).
- **dashboard memory search** — `GET /api/memories?q=` search endpoint + delete endpoint. search input + results list in dashboard HTML.
- **follow-up intent detection** (`src/followup.ts`) — pattern-based detection of casual future intents ("I'll do X tomorrow"). creates one-shot reminders automatically. skips explicit "remind me" (handled by schedule tools).
- **background research prompt** — deep tier system prompt instructs agent to consider spawning research sub-agents for unfamiliar topics.

#### v0.15 — GitHub + Browser + Spotify (via Composio)

- **github tools** — Composio GitHub toolkit auto-registers (create issue, list PRs, comment, check CI). connected via `koda setup composio`.
- **spotify MCP** — community `@modelcontextprotocol/server-spotify` via config.mcp.servers (docs only).
- **browser MCP** — Playwright `@modelcontextprotocol/server-playwright` via config.mcp.servers (docs only).

#### v0.16 — Polish

- **bootstrap split** — `src/index.ts` decomposed into `src/boot/config.ts`, `src/boot/providers.ts`, `src/boot/mcp.ts`, `src/boot/server.ts`. each exports a `bootXyz()` function. index.ts orchestrates the sequence.
- **ack templates from soul** — `soul.d/acks.md` provides custom acknowledgment templates. `SoulLoader.getAckTemplates()` reads them. falls back to built-in templates.
- **MCP tool namespacing** — when multiple MCP servers are configured, tool names are prefixed with server name (`${server.name}_${toolName}`) to prevent collisions.
- **failure-triggered MCP reconnect** — replaced 60s polling with on-demand reconnect via `reconnectMcpServer()`. tracks per-server reconnecting state to prevent concurrent attempts.
- **structured JSON logging** — `LOG_FORMAT=json` env var activates JSON output (`{ts, level, tag, msg}`). added `logInfo()` and `logWarn()` helpers.
- **`koda config get/set`** — CLI command to read/write config values. dot-path traversal, auto-parses booleans and numbers.
- **dashboard kill confirmation** — `confirm()` dialog before killing sub-agents.
- **dashboard usage export** — `GET /api/export/usage` returns CSV download of usage summaries.
- **flexible soul sections** — `updateSoul` tool accepts arbitrary section names (not just hardcoded enum).

#### dependencies

- **added**: `@composio/core` ^0.6.3, `@composio/vercel` ^0.6.3

#### new files

- `src/composio.ts` — Composio SDK wrapper
- `src/followup.ts` — follow-up intent detection
- `src/boot/config.ts` — config boot phase
- `src/boot/providers.ts` — providers boot phase
- `src/boot/mcp.ts` — MCP boot phase
- `src/boot/server.ts` — HTTP server boot phase
- `config/soul.d/acks.md` — default ack templates

#### config

- **added**: `composio.apiKey`
- **version**: `0.12.0` → `1.0.0`

---

## 2026-02-23
### v0.12.0 — scheduler hardening, task tracking, delimiter fix, context.md, token trim, request IDs, skills

hardening pass before 1.0. scheduler now skips stale one-shots (30 min grace window), tracks consecutive task failures and auto-disables after 3, and delays first tick to avoid race conditions on restart. message delimiter is properly protected inside code blocks and stripped from conversation history. workspace context loading via CONTEXT.md, token-based history trimming, request IDs for log tracing, and 4 new built-in skills.

#### added

- **task failure tracking** — `last_status` and `consecutive_failures` columns on tasks table (migration v4). `markResult()` helper tracks ok/error after each scheduled agent run. tasks auto-disable after 3 consecutive failures with user notification.
- **scheduler grace window** — one-shot reminders older than 30 minutes are skipped on restart instead of firing stale. 5-second boot delay prevents race between `catchUp()` and first tick.
- **`splitOnDelimiter()` export** — code-block-aware message splitting. protects `<|msg|>` inside fenced and inline code blocks from being split. used by telegram, repl, and streaming channels.
- **CONTEXT.md support** — place a `CONTEXT.md` file in your workspace (`~/.koda/CONTEXT.md`) to inject project context into every system prompt. hot-reloads on file change with 300ms debounce.
- **token-based history trim** — replaces fixed message count (24) with estimated token budget (6000 tokens ≈ 24k chars). keeps more short messages, trims fewer long ones.
- **request IDs** — every agent request gets an 8-char UUID prefix in logs (e.g. `[a1b2c3d4]`). sub-agents use `[sub-xxxxxxxx]` prefix. threads through all downstream log calls.
- **4 new built-in skills** — `code-review`, `summarize-url`, `deep-research`, `task-breakdown`. follows existing SKILL.md format.

#### changed

- **delimiter handling** — `<|msg|>` references removed from soul.md, response.md, DEFAULT_SOUL, generateDefault(), createDefaultSoulDir(). `buildSystemPrompt` in agent.ts remains the single source of truth for delimiter instructions. delimiters are now stripped from conversation history before DB storage and memory ingestion.
- **streaming split** — telegram streaming now tracks code block fence count and only splits buffer when outside code blocks.

#### config

- **version**: `0.11.0` → `0.12.0`

---

## 2026-02-23
### v0.11.0 — voice, memory cleanup, scheduler fix, tiered prompt, skills merge, sub-agent improvements

hardening pass. voice notes via Gemini Flash transcription, Supermemory as sole memory provider (local/stub removed), scheduler double-fire race condition fixed, token savings via tiered system prompts, skills+skillshop merged into one tool, and sub-agents get tier/context/timeout control.

#### added

- **voice message transcription** — send voice messages or circle videos in Telegram. audio is transcribed via Gemini Flash (OpenRouter `input_audio` content part) and passed to the agent as `[voice message]` text.
- **tiered system prompt** — fast tier gets an abbreviated system prompt (~800-1000 fewer tokens): no XML time tags, no workspace path, one-line delimiter rules, skills summary skipped.
- **sub-agent tier control** — `spawnAgent` accepts optional `tier` param to force sub-agent to fast or deep tier.
- **sub-agent context passing** — `spawnAgent` accepts optional `context` param to share relevant conversation context with the child agent.
- **sub-agent custom timeout** — `spawnAgent` accepts optional `timeoutMs` (10s–5min) for per-spawn timeout control.
- **sub-agent writeFile** — `writeFile` added to default sub-agent tool allowlist.

#### changed

- **memory: Supermemory-only** — removed local embeddings provider (Ollama + cosine similarity), stub provider (SQLite keyword fallback), `setMemoryTimeout()`, `ollamaEmbed()`, `cosineSimilarity()`. factory now returns Supermemory or a graceful no-op.
- **skills + skillshop merged** — single `skills` tool with 6 actions: list, load, create, search, preview, install. `skillshop.ts` deleted. Exa import is conditional (search/preview/install gracefully fail without key).
- **scheduler race fix** — recurring tasks now advance `next_run_at` BEFORE running the agent (prevents double-fire when tick fires again during async agent execution). Agent call is fire-and-forget.
- **sub-agent system prompt** — restructured with ## headers (Your task, Context from parent, Rules) for clarity.

#### removed

- `src/tools/skillshop.ts` — merged into `src/tools/skills.ts`
- `vector_memories` table — removed from schema, migration v2, and exports
- `embeddings` config block — removed from Zod schema
- `setMemoryTimeout()` export — no longer needed
- `createLocalMemoryProvider()` — removed
- `createStubMemoryProvider()` — removed
- `skillShop` from sub-agent ALWAYS_BLOCKED — tool no longer exists

#### config

- **removed**: `embeddings` block (was: `enabled`, `ollamaUrl`, `model`, `maxMemories`)
- **version**: `0.10.0` → `0.11.0`

---

## 2026-02-23
### v0.10.0 — feature pass

substantial feature release filling real gaps before 1.0. koda now handles documents, respects reply context, generates images, sends files, backs up its database, supports webhook mode, and has a cleaner dashboard.

#### added

- **document/PDF ingestion** — send PDFs and text files (.txt, .md, .csv, .json, .html, .xml) in Telegram. extracted via `pdf-parse` (new dependency). truncated at 30k chars.
- **reply threading** — replying to a message passes the replied-to text as context to the agent.
- **forwarded message metadata** — forwarded messages include the original sender/channel name as context.
- **edited message handling** — editing a sent message triggers a new agent response with `[edited]` prefix.
- **image generation tool** (`src/tools/image.ts`) — `generateImage(prompt, size?)` calls OpenRouter image models (default: `google/gemini-3-pro-image-preview`). image URLs in responses are auto-sent as Telegram photos.
- **send file tool** (`src/tools/files.ts`) — `sendFile(path, caption?)` queues workspace files to be sent as Telegram document attachments after the agent completes.
- **database backup** (`src/db.ts`) — `backupDatabase()` with WAL checkpoint, daily auto-backup to `~/.koda/backups/`, 7-day retention. runs once at boot and every 24h.
- **webhook mode** — optional Telegram webhook support via `config.telegram.useWebhook`. webhook handler at `POST /telegram`.
- **startup/shutdown notifications** — admin users receive Telegram messages when koda comes online or shuts down.
- **tier override** — `/deep` and `/fast` commands force the next message to a specific model tier. `AgentInput.tierOverride` skips `classifyTier()`.
- **`/status` command** — system health summary: version, uptime, memory, LLM status, today's cost, models, next task.
- **`/recap` command** — summarize recent conversation via the agent.
- **`/model` command** — view and change fast/deep/image models on the fly. persisted to config.json via `persistConfig()`.
- **config persistence** (`src/config.ts`) — `persistConfig(config)` writes current config back to the resolved config file path.
- **config fields**: `openrouter.imageModel`, `telegram.useWebhook`, `telegram.webhookUrl`, `telegram.webhookSecret`, `features.autoBackup`.
- **`AgentResult.files`** — optional file array returned from agent for channel-layer delivery.
- **`pendingFiles` in tool context** — tools can queue files via `addPendingFile()` for post-response delivery.

#### changed

- **dashboard simplified** — removed RAM graph, memory graph page, live sub-agent streaming logs, supermemory docs browser. added current model display and uptime. ~1980 → ~700 lines.
- **`metrics.ts` deleted** — only used for RAM graph. process memory stats still available via `/status` command.
- **events.ts** — removed `memory` event type (no longer needed without RAM graph).
- **dashboard deps** — now receives `config` object for model display.

#### removed

- **bench** — moved to its own repository. all bench scripts, runner, judge, scorers, report, and test cases removed.
- **RAM graph** — over-engineered for personal assistant.
- **memory graph page** — force-directed graph of 2k nodes, overkill.
- **supermemory docs browser** — not needed in dashboard.

#### dependencies

- **added**: `pdf-parse` ^1.1.1
- **version**: `0.9.0` → `0.10.0`

---

## 2026-02-23
### v0.9.0 — audit & cleanup

honest versioning. koda works end-to-end, architecture is proven, but it hasn't earned 1.0 yet. this pass removes dead code, fixes bugs, aligns docs to reality, and strengthens the bench.

#### removed (dead code)

- **`TOOL_HINTS` / `CODE_WORDS` arrays** (`src/router.ts`) — declared but never referenced by any function.
- **`getOllamaProvider()` export** (`src/agent.ts`) — exported but never called anywhere.
- **`learnings` table creation** (`src/db.ts`) — `CREATE TABLE IF NOT EXISTS learnings` removed from boot schema. table was never written to or read from since v1.3.0.
- **`@supermemory/tools` dependency** (`package.json`) — listed but never imported. koda uses the `supermemory` client directly.
- **`dbSubagents.getByName("")` dead call** (`src/tools/subagent.ts`) — in `killSpawn()`, queried with empty string and result unused.
- **`proactive.activeHoursStart/End`** (`config/config.json`) — not in Zod schema, silently dropped on parse.
- **`EXECUTIVE_BREAKDOWN.md`** — one-off audit artifact, not project documentation.

#### fixed

- **LLM judge delimiter mismatch** — `bench/cases/llm-judge.json` used `\n|||\n` as message separator but the codebase uses `<|msg|>` (defined in `agent.ts` and referenced in `judge.ts`). all 15 test responses updated.
- **docker-compose volume mount** — mounted `koda-data:/app/workspace` but app writes to `~/.koda` (`/root/.koda` in container). changed to `koda-data:/root/.koda`.
- **soul voice claim** — `config/soul.md` claimed "can hear and transcribe voice messages" but no voice handling exists. removed.
- **negative test dimension names** — LLM judge negative test used misleading dimension names (`safety`, `accuracy`, `helpfulness`) for violation-detection rubrics. renamed to `violation_detection`, `rule_breaking_count`, `detectability`.

#### changed

- **`addToolCost` consolidation** — search tools in `tools/index.ts` used direct `getToolContext().toolCost.total += amount` instead of `addToolCost()`. consolidated to use the shared helper.
- **config timeouts wired up** — `config.timeouts.memory` now drives the Ollama embedding timeout in `memory.ts` (was hardcoded 10_000). `config.timeouts.search` drives the Supermemory docs fetch timeout in `dashboard.ts` (was hardcoded 15_000).
- **config.json alignment** — removed undeclared `proactive.activeHoursStart/End`, set `debug: false` (was `true`).
- **version**: `2.1.0` → `0.9.0` (honest pre-release numbering).

#### bench

- **+8 time/cron cases** (5 → 13): exact-match-advances-day, same-weekday-past-time, weekend schedule, midnight edge, timezone offset, multiple weekdays past time.
- **+4 classify cases** (39 → 43): empty input, single character, non-English text, `/think` prefix override, multiple soft signal accumulation, long message with connectors, just-below-threshold.
- **+3 ack cases** (10 → 13): fast+task intent, ok-prefix with complex request, heartbeat source suppression.
- **total**: 74 → 93 deterministic cases.

#### docs

- **README rewrite** — version badge `v0.9.0`, bench count updated, added tool cost tracking / sub-agent streaming / memory provider selection. removed `learnings` from database table. added `timeouts` to config reference.
- **CHANGELOG consolidated** — merged `docs/CHANGELOG.md` (complete history) into root `CHANGELOG.md`. deleted `docs/CHANGELOG.md`.

---

## 2026-02-18
### v2.1.0 — safe context compaction · live sub-agent streaming · tool cost accounting · structured agent returns

#### added

- **`trimHistory()` pre-flight compaction** (`src/agent.ts`) — replaces the in-place `messageList.splice()` mutation that ran inside `prepareStep`. A new `trimHistory(messages, maxMessages = 24)` function is called *before* `generateText`/`streamText`, producing a fresh array with a single placeholder for dropped messages. The SDK never sees a mid-run mutation of the array it holds, eliminating potential dropped-tool-result and sync bugs.
- **`streamUpdate` tool** (`src/tools/subagent.ts`) — injected into every sub-agent's toolset as a closure bound to its `sessionKey`. When the child calls `streamUpdate({ message })`, it emits a `subagent_update` SSE event and logs `[spawn:Name] message` to the console. The main dashboard immediately displays these lines under the running spawn row without any polling.
- **`returnResult` tool** (`src/tools/subagent.ts`) — injected alongside `streamUpdate`. Sub-agents are instructed to always call `returnResult({ summary, data? })` when they finish. The parent `spawnAgent` returns `{ result: summary, structured: { summary, data } | null }` — deterministic, parseable output instead of a raw text blob.
- **Tool cost accumulator** (`src/tools/index.ts`) — `ToolRuntimeContext` now carries `toolCost: { total: number }`. `withToolContext` accepts it from the caller; tools mutate it via `addToolCost(amount)`. After `generateText` completes, the accumulated total is passed to `dbUsage.track()`.
- **Exa cost tracking** (`src/tools/search.ts`) — `registerSearchTools` accepts an `onCost?(amount)` callback. `webSearch` reports `$0.005` per call; `extractUrl` reports `$0.001 × urls`.
- **`tool_cost` DB column** (`src/db.ts`, schema v3) — `ALTER TABLE usage ADD COLUMN tool_cost REAL NOT NULL DEFAULT 0` migration runs on boot.
- **Dashboard live sub-agent log** (`src/dashboard.ts`) — running spawn rows display a scrollable mono log pane (last 8 lines).
- **Dashboard tool cost display** — usage cards show `+$X.XXX tools` beneath the LLM cost when `totalToolCost > 0`.

#### changed

- `makePrepareStep` signature drops the `messageList` parameter — it now handles tier escalation only.
- `finalizeResult` accepts an optional `toolCost` param and passes it to `dbUsage.track()`.
- Sub-agent system prompt updated to instruct use of `streamUpdate` and `returnResult`.

---

## 2026-02-19
### v1.6.0 — RAM auto-clean · live spawns · safe score · smarter router · natural cron · RAM graph · Docker sandbox · Ollama · named agent chat

#### added

- **`src/metrics.ts`** — `recordMemSample()` ring buffer (10 min history).
- **Hourly RAM auto-clean** — `dbMessages.cleanup(90)` + `vacuumDb()` every hour.
- **Kill sub-agent** — each in-flight sub-agent tracked with `AbortController`. Dashboard exposes `DELETE /api/spawns?session=<key>`.
- **Named session registry** — `spawnAgent` registers `name → sessionKey`. Returns a `note` field suggesting the `@AgentName:` syntax.
- **Direct sub-agent chat** — `@AgentName: message` prefix routes to sub-agent's conversation history.
- **Skill Shop safe score** — `calculateSafeScore(content)` returns 0–100 based on weighted pattern severity.
- **Weighted tier classification** — additive score: strong keywords (+3), soft keywords (+1), length signals, connectors. Threshold ≥ 3 → deep.
- **`parseNaturalSchedule()`** — converts natural language schedules into cron format.
- **Dashboard RAM graph** — SVG polyline sparkline with heap, RSS, external stats.
- **Docker safe sandbox** — `runSandboxed` tool with resource limits (512MB RAM, 0.5 CPU, no network).
- **Ollama local model support** — fast-tier uses local model when configured.

---

## 2026-02-19
### v1.5.0 — Sub-agent hardening + config-driven tuning + spawn dashboard

#### added

- **`config.subagent` block** — `timeoutMs` and `maxSteps` externalized.
- **Sub-agent memory isolation** — `ingestConversation: async () => {}` prevents child→user memory writes.
- **Spawn log ring buffer** — last 50 entries, exported via `getSpawnLog()`.
- **Dashboard spawn panel** — "Sub-Agent Activity" section.
- **Weekly skill discovery task** — seeded on first boot.

---

## 2026-02-19
### v1.4.0 — Skill Shop + Dashboard + Exa improvements

#### added

- **Skill Shop** — search, preview, install SKILL.md files from GitHub via Exa.
- **Safety scanner** — regex scan blocking exfiltration, destructive, injection patterns.
- **Dashboard** — dark-mode single-page app with usage, skills, tasks.

#### changed

- **Exa `webSearch`** — switched to `highlights: { maxCharacters: 2000 }`.
- **Exa `extractUrl`** — `text: { maxCharacters: 15000 }`.

---

## 2026-02-18
### v1.3.3 — 2-tier router: Gemini Flash + Claude Sonnet

- 3-tier → 2-tier. `standard` tier removed.
- fast: `google/gemini-3-flash-preview`. deep: `anthropic/claude-sonnet-4.6`.

---

## 2026-02-18
### v1.3.2 — Exa search + voice pipeline removal

- Exa replaces Tavily. Voice pipeline removed entirely.

---

## 2026-02-18
### v1.3.1 — MCP stdio transport + auto-restart

- stdio MCP transport for local servers.
- 60s health-check with auto-reconnect.

---

## 2026-02-18
### v1.3.0 — auto-learning, MCP, streaming, hardening

- Supermemory user profiles replace learnings table.
- Conversation ingestion.
- MCP client support.
- `systemStatus` tool.
- `streamText` for Telegram.
- SQLite migration system.

---

## 2026-02-16
### v1.2.0 — leaner runtime + multimodal fixes

- Removed stagehand browser tools, heartbeat file loop, unused memory deletion.
- Fixed photo understanding, usage accounting, typing race.
- Switched delimiter from `|||` to `<|msg|>`.

---

## 2026-02-16
### v1.1.3 — outgoing message deduplication

---

## 2026-02-13
### v1.1.2 — reminder reliability + character consistency

- Reminders now fire 24/7. Near-term precision via `scheduleNudge()`.

---

## 2026-02-13
### v1.1.1 — dev logging + emoji tuning + cleanup

- Debug logging via `config.features.debug`.

---

## 2026-02-13
### v1.1.0 — hardening + voice pipeline upgrade

---

## 2026-02-13
### v1.0.1 — stability + safety patch

---

## 2026-02-12
### v1.0.0 — the rebuild

Ground-up rewrite. 12-stage pipeline → single `generateText` tool loop. 19 source files, 2,862 lines.

---

## 2026-02-08
### v0.1.0 — prototype

Initial prototype. 46 source files, 5,400 lines. Proved the concept.
