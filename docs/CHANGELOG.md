# changelog

all notable changes to koda.

---

## v1.1.1 — dev logging + emoji tuning + cleanup (2026-02-13)

small quality-of-life release. adds opt-in debug logging for the full message lifecycle, tones down emoji usage in soul files, and cleans up stale v1.0 references.

### added

- **debug logging** — set `"debug": true` in config.json `features` to enable `[tag]` console logs across the entire message lifecycle: tier/intent classification, model selection, context compaction, model escalation, tool calls, token usage + cost, telegram message routing, STT/TTS, proactive ticks, memory operations. zero-cost when disabled.
- **`src/log.ts`** — tiny `log(tag, ...args)` helper. `enableDebug()` activates it on boot.

### changed

- **soul emoji cleanup** — removed all 🧊 usage (was 3 occurrences). 🐻‍❄️ kept where identity matters (3 uses). added one 🐾 on protocol header. emojis now used sparingly.
- **version bump to 1.1.1** — updated `package.json`, health endpoint, soul default version, all file headers.
- **header cleanup** — removed "v1" from file header comments in `src/config.ts`, `src/index.ts`, `.env.example`.

---

## v1.1.0 — hardening + voice pipeline upgrade (2026-02-13)

hardening release. ships all 8 v1.1 roadmap items plus a full voice pipeline swap.

### changed

- **voice STT: groq whisper → gemini 3 flash via openrouter** — eliminates a separate API key. STT now reuses the existing openrouter key. gemini handles audio natively as multimodal input (`input_audio` with base64 ogg).
- **voice TTS: openai tts-1 → cartesia sonic 3** — lower latency (~40ms), better voice quality. configurable voice id via `voice.cartesiaVoiceId` (defaults to `694f9389-aac1-45b6-b726-9d9369183238`).
- **voice-only reply** — voice messages now get voice replies only (no duplicate text message). falls back to text when TTS is unavailable.
- **config: voice keys replaced** — `voice.groqApiKey` + `voice.openaiApiKey` replaced by `voice.cartesiaApiKey` + `voice.cartesiaVoiceId`. env vars: `KODA_CARTESIA_API_KEY` + `KODA_CARTESIA_VOICE_ID` replace `KODA_GROQ_API_KEY` + `KODA_OPENAI_API_KEY`.
- **message dedup by content hash** — switched from message_id-based dedup to `Bun.hash()` content hashing. identical messages with different IDs now correctly deduplicated. voice uses message_id hash (content unknown pre-transcription), photos hash caption.
- **telegram reconnect with exponential backoff** — `bot.start()` now retries with exponential backoff + jitter on connection failure. consecutive error tracking auto-restarts bot after 5 failures.
- **context compaction** — when tool step count exceeds 10, `prepareStep` splices older messages keeping last 6. prevents context window exhaustion on deep tool chains.
- **heartbeat structured parsing** — heartbeat now parses `- [ ]` / `- [x]` checkboxes from HEARTBEAT.md. only sends pending items with structured count to agent (e.g. "you have 3 pending tasks (2 completed)").

### no-op

- **skill hot-reload** — marked done. `loadSkill()` already reads the file fresh every call, `listSkills()` scans directories every call. no cache to invalidate.

---

## v1.0.1 — stability + safety patch (2026-02-13)

bugfix release focused on setup reliability, request isolation, scheduler delivery, and filesystem hardening.

### fixed

- **setup/runtime env mismatch** — runtime now loads both `~/.koda/.env` and project `.env`, so `koda setup` works without manual env copying.
- **required key inconsistency** — setup now requires `KODA_SUPERMEMORY_API_KEY`, matching config validation.
- **request context race** — tools now use request-scoped context via `AsyncLocalStorage` to prevent cross-chat/user leakage under concurrency.
- **telegram proactive delivery** — scheduler reminders now send through Telegram when the task channel is telegram.
- **soul persistence** — `updateSoul` now writes changes back to `soul.md` instead of mutating in-memory only.
- **filesystem symlink escape** — write path validation now checks real paths of existing parents and blocks symlink writes outside workspace.
- **cron schedule validation** — invalid weekday/time inputs now fail fast instead of drifting into bad scheduling behavior.
- **exec portability** — shell execution is now platform-aware (`cmd.exe` on Windows, `sh` on Unix-like systems).
- **telegram dedup collisions** — dedup keys now include chat id + message id to avoid cross-chat false positives.
- **memory fallback targeting** — sqlite fallback recall now accepts the active session key so lookups hit the correct conversation history.
- **cli entrypoint** — `bun run src/cli.ts <command>` now executes commands directly (`koda` script is functional).

### changed

- bumped version to **1.0.1** (`package.json`, CLI version output, health endpoint version).

## v1.0.0 — the rebuild (2026-02-12)

ground-up rewrite. threw away the over-engineered prototype, kept the good ideas, rebuilt everything from scratch.

### added

- **3-tier llm routing** — fast/standard/deep replaces 4-tier simple/medium/complex/reasoning. rule-based keyword classifier instead of 8-dimension weighted scoring. cheaper, faster, predictable.
- **model escalation** — `prepareStep` callback automatically upgrades the model mid-conversation if the agent exceeds 5 tool steps on a lower tier. starts cheap, scales only when needed.
- **voice pipeline** — full voice I/O via telegram. groq whisper for speech-to-text, openai tts-1 for text-to-speech. raw `fetch()` calls, no sdk dependencies.
- **local code execution** — `Bun.spawn()` replaces E2B cloud sandboxes. auto-backgrounds processes after 10s timeout. blocked commands list for safety. process management (poll, stream logs, kill).
- **interactive cli** — `koda setup` wizard with @clack/prompts, `koda doctor` health checks with ora spinners, `koda upgrade` self-update from github releases, `koda version`.
- **learnings table** — sqlite table for storing corrections and preferences. persists across sessions.
- **closure-based tool context** — shared `toolContext` object set per-request, replacing AsyncLocalStorage threading.
- **health server** — `GET /health` endpoint on port 3000 for docker/railway health checks.

### changed

- **architecture** — 12-stage middleware pipeline replaced by single `generateText` tool loop. the vercel ai sdk handles the entire agent loop via `stepCountIs(30)`.
- **message routing** — typed MessageBus replaced by direct `runAgent()` function calls from channels. no message bus, no pub/sub.
- **config** — 4-tier model config (simpleModel/mediumModel/complexModel/reasoningModel) replaced by 3-tier (fastModel/standardModel/deepModel). added voice keys (groqApiKey, openaiApiKey).
- **database** — dropped `task_attempts` and `task_outcomes` tables. kept 5 tables: messages, tasks, usage, learnings, state.
- **memory** — circuit breaker inlined into memory provider (3 failures in 60s trips). sqlite fallback searches messages table by keyword when supermemory is down.
- **tools** — memory tools renamed: addMemory to remember, searchMemories to recall. 8 tool modules instead of 9 capabilities with 28 tools.
- **soul** — simplified loader. no backup complexity, no version tracking. hot-reload via file watcher.
- **skills** — index-first loading. only skill names and descriptions go into the system prompt. full skill content loaded on demand.
- **proactive** — simplified tick loop. direct function calls instead of message bus dispatch. catch-up logic for missed reminders.
- **benchmarks** — adapted from 113 cases (many testing removed features) to 55 deterministic + 15 llm-judged cases. 100% pass rate. removed outcome, safety, and budget scorers.
- **telegram** — inline rate limiting and message dedup instead of separate middleware. voice message support. photo caption support.

### removed

- **middleware pipeline** — the 12-stage `(ctx, next) => Promise<void>` pipeline. replaced by a single function.
- **MessageBus** — typed pub/sub message routing. channels now call functions directly.
- **AsyncLocalStorage** — context threading for request-scoped state. replaced by a simple closure object.
- **E2B sandbox** — cloud-based code execution. replaced by local `Bun.spawn()`.
- **4-tier routing** — 8-dimension weighted scoring classifier with complexity/ambiguity/technicality/scope/urgency/tool/interaction/creativity dimensions.
- **focus mode** — urgency detection and message holding system for non-urgent proactive messages.
- **outcome learning** — extraction of success/failure/partial signals from user feedback. deferred to v2.
- **budget scoring** — message importance scoring for context window management. deferred to v2.
- **safety detector** — prompt injection detection via keyword matching. deferred to v2.
- **onboarding stage** — first-message detection and welcome flow.
- **session stage** — conversation session management with idle timeouts.
- **context budget** — token budget allocation and message pruning.
- **`@supermemory/tools`** — unused dependency. we use `supermemory` client directly.
- **`e2b`** — cloud sandbox dependency.
- **12 CLI files** — custom terminal UI with gradients, typewriter effects, ASCII banners. replaced by 1 file with @clack/prompts.
- **`src/cli/embedded.ts`** — build-time asset bundling for compiled CLI binary.
- **stale docs** — ARCHITECTURE.md, SETUP.md, TOOLS.md, BENCHMARKS.md, CLI.md, README_SIMPLE.md. all referenced the old architecture.

### stats

| metric | v0 (prototype) | v1 (rebuild) |
|--------|---------------|-------------|
| source files | 46 | 19 |
| total lines | 5,400 | 2,862 |
| dependencies | 12 | 10 |
| tool modules | 9 capabilities | 8 modules |
| benchmark cases | 113 | 70 |
| benchmark pass rate | 100% | 100% |

---

## v0.1.0 — prototype (2026-02-08)

initial prototype. proved the concept but was over-engineered for a personal assistant.

- 12-stage composable middleware pipeline
- 4-tier llm routing (simple/medium/complex/reasoning) with 8-dimension weighted scoring
- typed MessageBus with pub/sub channels
- AsyncLocalStorage context threading
- supermemory semantic memory with circuit breaker
- E2B cloud sandboxed code execution
- focus mode with urgency detection
- outcome learning (success/failure/partial extraction)
- budget scoring for context window management
- prompt injection detection
- stagehand headless browser (5 actions)
- skills system with hot-reload SKILL.md files
- soul personality with hot-reload and versioned backups
- proactive system (reminders, recurring tasks, heartbeat)
- telegram channel with grammy
- cli channel with readline
- 113-case benchmark suite (98 deterministic + 15 llm-judged)
- sqlite with WAL mode (6 tables)
- custom CLI with 12 files, gradients, typewriter effects
