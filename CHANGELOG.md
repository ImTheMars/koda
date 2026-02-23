# changelog

all notable changes to koda.

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
