# KODA v2 — EXECUTIVE AUDIT REPORT

**Date:** February 26, 2026
**Version Audited:** v1.0.1
**Audited By:** Automated 6-Agent Parallel Audit
**Total Source Lines:** ~7,900 TypeScript
**Runtime:** Bun 1.2+ / TypeScript 5.9 (strict)

---

## TABLE OF CONTENTS

1. [Executive Summary](#1-executive-summary)
2. [What We Have — Complete System Map](#2-what-we-have)
3. [Architecture & Data Flow](#3-architecture--data-flow)
4. [Component Deep-Dive](#4-component-deep-dive)
5. [External Integrations Map](#5-external-integrations-map)
6. [Tool System Inventory](#6-tool-system-inventory)
7. [Code Quality Report](#7-code-quality-report)
8. [Security Audit](#8-security-audit)
9. [Performance Profile](#9-performance-profile)
10. [Testing & QA Status](#10-testing--qa-status)
11. [What Should Change](#11-what-should-change)
12. [What Should Be Removed](#12-what-should-be-removed)
13. [What Should Be Consolidated](#13-what-should-be-consolidated)
14. [What's Missing](#14-whats-missing)
15. [Prioritized Action Plan](#15-prioritized-action-plan)
16. [Issue Registry](#16-issue-registry)

---

## 1. EXECUTIVE SUMMARY

### What Koda Is

Koda is a **production-deployed personal AI assistant** running on Railway, accessible via Telegram, with a web dashboard, semantic memory, proactive scheduling, code sandbox, sub-agent delegation, and extensible skill/tool architecture. It uses a **two-tier LLM routing system** (fast/cheap via Gemini Flash, deep/capable via Claude Sonnet) with automatic tier escalation.

### Current State: Solid Foundation, Needs Hardening

| Area | Grade | Summary |
|------|-------|---------|
| **Architecture** | A- | Clean modular design, good separation, well-orchestrated boot |
| **Feature Set** | A | Rich — memory, scheduling, sandbox, sub-agents, skills, MCP |
| **Code Quality** | B- | 31+ `any` types, 30+ swallowed errors, inconsistent patterns |
| **Security** | B | Good foundations (path containment, sandboxing), gaps in logging/validation |
| **Testing** | D | Zero unit/integration tests, only LLM-judge benchmarks |
| **Performance** | B+ | Fast boot, good async patterns, some blocking operations |
| **Observability** | C | No structured logging, no metrics, no tracing |
| **Documentation** | B | Good README/CHANGELOG, missing dev guides |

### The Verdict

The product is **architecturally sound and feature-rich** — far beyond a typical personal bot. The core message flow (classify → build prompt → tool loop → post-process) is well-designed. However, it's accumulated **technical debt in error handling, type safety, and testing** that will compound as the system grows. The next phase should focus on **hardening over new features**.

---

## 2. WHAT WE HAVE

### Complete File Tree

```
koda-v2/
├── .github/workflows/
│   └── release.yml                 # CI: multi-platform binary builds on tag push
├── config/
│   ├── config.json                 # Active runtime configuration
│   ├── config.example.json         # Config template (all options documented)
│   ├── soul.md                     # Agent personality definition
│   └── soul.d/
│       ├── acks.md                 # Acknowledgment response templates
│       ├── protocol.md             # Communication protocol rules
│       ├── response.md             # Response formatting guidelines
│       └── security.md             # Safety & boundary rules
├── skills/                         # Built-in skill definitions (SKILL.md)
│   ├── code-review/SKILL.md
│   ├── deep-research/SKILL.md
│   ├── morning-briefing/SKILL.md
│   ├── summarize-url/SKILL.md
│   ├── task-breakdown/SKILL.md
│   └── web-research/SKILL.md
├── scripts/
│   ├── build.ts                    # Build script (unused)
│   └── install.sh                  # Installation script for releases
├── src/
│   ├── index.ts                    # ENTRY POINT — 13-phase boot orchestrator
│   ├── agent.ts                    # Core agent: generateText/streamText loops
│   ├── router.ts                   # 2-tier classification (fast/deep) + intent routing
│   ├── config.ts                   # Zod schema + env overrides + persistence
│   ├── cli.ts                      # CLI commands (setup, doctor, upgrade, config)
│   ├── db.ts                       # SQLite WAL + schema migrations (v1→v4)
│   ├── env.ts                      # .env file parser
│   ├── composio.ts                 # Composio SDK wrapper (Gmail/Calendar/GitHub)
│   ├── dashboard.ts                # HTTP server + web UI (~700 lines)
│   ├── events.ts                   # Event bus (currently minimal use)
│   ├── log.ts                      # Structured logging module
│   ├── followup.ts                 # Follow-up intent detection
│   ├── proactive.ts                # Scheduler tick loop (30s interval)
│   ├── time.ts                     # Timezone-aware cron parsing
│   ├── version.ts                  # VERSION constant from package.json
│   ├── boot/
│   │   ├── config.ts               # Phase 1: Config load + workspace mkdir
│   │   ├── providers.ts            # Phase 2: Memory, soul, skills initialization
│   │   ├── mcp.ts                  # Phase 3: MCP server connections
│   │   ├── server.ts               # Phase 4: HTTP server (dashboard + webhooks)
│   │   └── railway-monitor.ts      # Railway build status polling
│   ├── channels/
│   │   ├── telegram.ts             # Telegram bot (polling + webhook modes)
│   │   └── repl.ts                 # CLI REPL for local testing
│   ├── tools/
│   │   ├── index.ts                # Tool builder + AsyncLocalStorage context
│   │   ├── memory.ts               # remember/recall via Supermemory (+ circuit breaker)
│   │   ├── search.ts               # webSearch/extractUrl via Exa
│   │   ├── filesystem.ts           # readFile/writeFile/listFiles (path-sandboxed)
│   │   ├── schedule.ts             # createReminder/createRecurringTask/listTasks
│   │   ├── skills.ts               # Skill management (list/load/create/search/install)
│   │   ├── soul.ts                 # getSoul/updateSoul with hot-reload
│   │   ├── status.ts               # systemStatus (uptime, memory, cost)
│   │   ├── sandbox.ts              # runSandboxed (Docker or native Bun exec)
│   │   ├── image.ts                # generateImage via OpenRouter
│   │   ├── files.ts                # sendFile (queues files for delivery)
│   │   └── subagent.ts             # spawnAgent + streamUpdate + returnResult
│   └── bench/                      # Benchmark suite (experimental)
│       ├── index.ts                # CLI entry
│       ├── suite.ts                # 44 test cases / 13 categories
│       ├── runner.ts               # Execution engine
│       ├── judge.ts                # Hybrid grading (programmatic + LLM)
│       ├── simulator.ts            # Scenario-to-message generation
│       ├── report.ts               # JSON/console reporting
│       └── types.ts                # Type definitions
├── Dockerfile                      # Docker: oven/bun:1 base
├── docker-compose.yml              # Local compose stack
├── package.json                    # v1.0.1, 14 dependencies
├── tsconfig.json                   # Strict TypeScript, ESNext
├── bun.lock                        # Dependency lock
├── README.md                       # Main documentation
└── CHANGELOG.md                    # Release history (v0.1.0 → v1.0.1)
```

### Dependencies (14 total)

| Package | Purpose | Status |
|---------|---------|--------|
| `ai` v6 | Vercel AI SDK (generateText/streamText) | Core — essential |
| `@ai-sdk/mcp` | Model Context Protocol support | Core — essential |
| `@openrouter/ai-sdk-provider` | OpenRouter LLM routing | Core — essential |
| `grammy` | Telegram bot framework | Core — essential |
| `zod` v4 | Runtime schema validation | Core — essential |
| `supermemory` v4 | Semantic memory storage | Feature — optional |
| `exa-js` | Web search + content extraction | Feature — optional |
| `@composio/core` | Email/Calendar/GitHub OAuth | Feature — optional |
| `@composio/vercel` | Composio→AI SDK adapter | Feature — optional |
| `ollama-ai-provider` | Local Ollama LLM support | Feature — optional |
| `chalk` | Colored CLI output | Utility |
| `@clack/prompts` | Interactive CLI prompts | Utility |
| `ora` | Spinner/progress UI | Utility |
| `pdf-parse` | PDF text extraction | Utility |

### Database Schema (SQLite WAL, v4)

| Table | Purpose | Columns |
|-------|---------|---------|
| `messages` | Conversation history | id, session_key, role, content, tools_used, created_at |
| `tasks` | Reminders + recurring jobs | id, user_id, chat_id, channel, type, description, prompt, cron, next_run_at, last_run_at, enabled, one_shot, last_status, consecutive_failures, created_at |
| `usage` | Cost tracking | id, user_id, model, input_tokens, output_tokens, cost, tool_cost, tools_used, created_at |
| `state` | Key-value store | key, value, updated_at |
| `subagents` | Sub-agent logs | session_key, name, status, tools_used, cost, duration_ms, started_at, updated_at |

---

## 3. ARCHITECTURE & DATA FLOW

### Boot Sequence (13 Phases)

```
1. CLI Routing ─── setup / doctor / upgrade / version / config
2. bootConfig() ─── loadConfig() + Zod validation + env overrides
3. initDb() ─── SQLite + WAL + migrations (v1→v4) + cleanup
4. bootProviders() ─── memory + soul + skills + context watchers
5. buildTools() ─── register 11 tool groups
6. bootMcp() ─── connect MCP servers (stdio/SSE/HTTP)
7. createAgent() ─── build runAgent() + streamAgent() closures
8. registerSubAgentTools() ─── circular dep resolution
9. seedBuiltinTasks() ─── weekly skill discovery + daily briefing
10. startChannels() ─── Telegram (polling/webhook) + REPL
11. startProactive() ─── 30s tick scheduler loop
12. startHttpServer() ─── dashboard + health + API + webhooks
13. setupShutdownHandlers() ─── SIGINT/SIGTERM + cleanup
```

### Message Flow: User → Response

```
┌──────────────────────────────────────────────────────────────┐
│ USER MESSAGE (Telegram / CLI REPL)                           │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ CHANNEL LAYER (telegram.ts / repl.ts)                        │
│  • Parse message (text, attachments, voice, replies)         │
│  • Rate limit check (10 req/60s per chat)                    │
│  • Allow-list check                                          │
│  • Deduplication check                                       │
│  • Build AgentInput { content, userId, chatId, sessionKey }  │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ ROUTER (router.ts)                                           │
│  • classifyTier(text) → "fast" or "deep"                     │
│    ├─ Strong signals: /think, "step by step" → +3            │
│    ├─ Soft signals: "analyze", "compare" → +1 each           │
│    ├─ Length bonus: 120+ words → +1, 300+ → +2               │
│    └─ Threshold: score ≥ 3 = deep                            │
│  • classifyIntent(text) → chat/task/research/code/etc        │
│  • shouldAck() → send acknowledgment?                        │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ AGENT (agent.ts)                                             │
│  1. classifyAndAck() — send "working on it" if warranted     │
│  2. buildAgentContext() — parallel fetch profile + skills     │
│  3. buildSystemPrompt() — soul + context + profile + tools   │
│  4. getHistory() + trimHistory() — token budget (6000 chars)  │
│  5. buildMessages() — combine history + current input         │
│  6. withToolContext() — inject AsyncLocalStorage context      │
│  7. generateText() / streamText() — Vercel AI SDK call       │
│     ├─ Tool execution loop (max 30 steps)                    │
│     ├─ Tier escalation: fast→deep at step 5                  │
│     ├─ onStepFinish() — log tool calls + track cost          │
│     └─ Circuit breaker: 3 failures → 2min backoff            │
│  8. finalizeResult() — cost, usage, DB, memory ingest        │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ POST-PROCESSING                                              │
│  • splitOnDelimiter(<|msg|>) — multi-message responses       │
│  • Store in messages table                                   │
│  • Ingest to Supermemory (fact extraction every 3rd call)    │
│  • Track usage (tokens, cost, tool cost)                     │
│  • Detect follow-up intents → create tasks                   │
│  • Queue pending files for delivery                          │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│ CHANNEL OUTPUT                                               │
│  • Stream message chunks (400ms delay between segments)      │
│  • Send photos (if image generation used)                    │
│  • Send documents (if files queued)                          │
│  • Clear typing indicator                                    │
└──────────────────────────────────────────────────────────────┘
```

### Scheduler Flow

```
┌─────────────────────────────────────────┐
│ PROACTIVE SCHEDULER (30s tick loop)      │
│  1. Query tasks: next_run_at ≤ now()    │
│  2. Skip one-shots >30min old           │
│  3. Advance next_run_at BEFORE exec     │
│  4. runAgent(task.prompt) fire-and-forget│
│  5. Track: ok → reset failures          │
│            error → failures++           │
│            3 failures → auto-disable    │
└─────────────────────────────────────────┘
```

### Sub-Agent Flow

```
┌─ Parent Agent calls spawnAgent() ──────┐
│  • Isolated session key                │
│  • Filtered toolset (no recursion)     │
│  • Timeout: 90s (configurable)         │
│  • AbortController for cancellation    │
├────────────────────────────────────────┤
│  Sub-Agent Executes:                   │
│  • streamUpdate() → SSE to dashboard   │
│  • returnResult() → structured output  │
│  • Same tool loop as main agent        │
│  • Step cap: 5 (configurable)          │
├────────────────────────────────────────┤
│  Parent Receives:                      │
│  • { result, structured }              │
│  • Logged to subagents table           │
└────────────────────────────────────────┘
```

---

## 4. COMPONENT DEEP-DIVE

### 4.1 Two-Tier Model Routing

| | Fast Tier | Deep Tier |
|---|-----------|-----------|
| **Model** | Gemini 3 Flash Preview | Claude Sonnet 4.6 |
| **Cost** | ~$0.50/M tokens | ~$3/M tokens |
| **Use** | General chat, simple tasks | Complex analysis, multi-step |
| **Trigger** | Default | Score ≥ 3, or `/deep` command |
| **Escalation** | Auto-upgrade at step 5 | N/A |
| **Fallback** | OpenRouter failover chain | OpenRouter failover chain |

**Classification Scoring:**
- Strong keywords ("step by step", "chain of thought"): +3 each
- Soft keywords ("analyze", "compare", "evaluate"): +1 each
- Length >120 words: +1, >300 words: +1
- Multi-constraint connectors (≥3 "then/also/finally"): +1
- Commands: `/think`, `/deep` = instant deep

### 4.2 Memory System

**Architecture:** Supermemory cloud + SQLite fallback with circuit breaker

- **Store:** Semantic vector storage per user (`user-${userId}` containers)
- **Recall:** Vector similarity search with relevance ranking
- **Extraction:** LLM-powered fact extraction every 3rd conversation ingest
- **Fact Types:** preference, personal, project, decision, action, opinion
- **Deduplication:** Exact match + substring + >80% word overlap
- **Circuit Breaker:** 3 failures → 60s cooldown → SQLite keyword fallback

### 4.3 Personality System (Soul)

- **Primary:** `config/soul.md` — identity, core values, personality traits
- **Sections:** `config/soul.d/*.md` — modular personality components
- **Hot-Reload:** File watchers with 300ms debounce
- **Tools:** `getSoul()` / `updateSoul()` — runtime personality modification

### 4.4 Skills System

- **6 Built-in Skills:** code-review, deep-research, morning-briefing, summarize-url, task-breakdown, web-research
- **Discovery:** Search community skills via Exa
- **Installation:** Fetch from GitHub with safety scanning
- **Safety Scanner:** Pattern-based risk scoring (API theft, exfiltration, injection)
- **Format:** SKILL.md with YAML frontmatter (name, description, always flag)

### 4.5 Dashboard

- **Stack:** Bun.serve + inline HTML/CSS/JS (~700 lines)
- **Endpoints:** `/` (dashboard), `/health`, `/api/usage`, `/api/skills`, `/api/tasks`, `/api/spawns`, `/api/memories`, `/api/export/usage`
- **Live Updates:** SSE stream for sub-agent progress
- **Features:** Usage cards, skills panel, tasks panel, sub-agent activity, dark mode

### 4.6 Telegram Integration

- **Modes:** Polling (default) or Webhook (if URL configured)
- **Features:** Voice transcription (via Gemini), PDF/text ingestion, reply threading, forwarded message context, message dedup, rate limiting
- **Commands:** /help, /clear, /usage, /status, /debug, /deep, /fast, /recap, /model, /memories
- **Admin Notifications:** Startup, shutdown, Railway builds (production-only)

---

## 5. EXTERNAL INTEGRATIONS MAP

```
┌────────────────────────────────────────────────────────────────┐
│                         KODA v2                                │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ OpenRouter│  │Supermemory│  │   Exa    │  │  Composio    │  │
│  │ (LLMs)   │  │ (Memory) │  │ (Search) │  │ (OAuth Apps) │  │
│  │ REQUIRED │  │ OPTIONAL │  │ OPTIONAL │  │ OPTIONAL     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │             │                │          │
│  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐  ┌──────┴───────┐  │
│  │ Circuit  │  │ Circuit  │  │ Cost     │  │ Direct v3    │  │
│  │ Breaker  │  │ Breaker  │  │ Tracking │  │ API calls    │  │
│  │ 3f/120s  │  │ 3f/60s   │  │ $0.005/q │  │ (bypasses    │  │
│  └──────────┘  └──────────┘  └──────────┘  │  broken SDK) │  │
│                                             └──────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Telegram │  │ Railway  │  │ Ollama   │  │  MCP Servers │  │
│  │ (Chat)   │  │ (Deploy) │  │ (Local)  │  │ (Extensible) │  │
│  │ REQUIRED │  │ AUTO     │  │ OPTIONAL │  │ OPTIONAL     │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
│                                                                │
│  ┌──────────┐  ┌──────────┐                                   │
│  │ GitHub   │  │ Docker   │                                   │
│  │ (Skills) │  │ (Sandbox)│                                   │
│  │ OPTIONAL │  │ OPTIONAL │                                   │
│  └──────────┘  └──────────┘                                   │
└────────────────────────────────────────────────────────────────┘
```

| Integration | Auth Method | Error Strategy | Rate Limit | Cost |
|-------------|-------------|----------------|------------|------|
| OpenRouter | Bearer token | Circuit breaker (3f/120s) + failover chains | Server-side | $0.50-$15/M tokens |
| Supermemory | API key | Circuit breaker (3f/60s) + SQLite fallback | Server-side | Per-plan |
| Exa | API key | Single attempt, graceful error | Server-side | $0.005/search |
| Composio | API key header | Direct v3 API (bypasses broken SDK) | Server-side | Per-plan |
| Telegram | Bot token | Grammy error handling | 1 msg/sec | Free |
| Railway | Bearer token | 60s polling with 10s timeout | Server-side | Per-plan |
| Ollama | None (local) | Graceful fallback to OpenRouter | N/A | Free |
| GitHub | Token (optional) | HTTP status check | 60/hr (unauth) | Free |
| Docker | Daemon socket | Available/unavailable check | N/A | Free |
| MCP | Custom headers | Auto-reconnect (2s delay) | Server-side | Varies |

---

## 6. TOOL SYSTEM INVENTORY

### 11 Tool Groups, 20+ Individual Tools

| Tool Group | Tools | External API | Cost Tracked | Rate Limited |
|------------|-------|-------------|--------------|--------------|
| **Memory** | remember, recall, deleteMemory | Supermemory | No | Circuit breaker |
| **Search** | webSearch, extractUrl | Exa | Yes ($0.005/q) | No |
| **Filesystem** | readFile, writeFile, listFiles | None | No | No |
| **Schedule** | createReminder, createRecurringTask, listTasks, deleteTask | None | No | No |
| **Skills** | list, load, create, search, preview, install | Exa + GitHub | No | No |
| **Soul** | getSoul, updateSoul | None | No | No |
| **Status** | systemStatus | None | No | No |
| **Sandbox** | runSandboxed | Docker / Bun.spawn | No | No |
| **Image** | generateImage | OpenRouter | Yes | No |
| **Files** | sendFile | None | No | No |
| **Sub-Agent** | spawnAgent (+ streamUpdate, returnResult) | OpenRouter | Partial | No |

### Tool Context Architecture

```
AsyncLocalStorage per request:
├── userId
├── chatId
├── channel
├── toolCost { total: number }
└── pendingFiles: Array<{ path, caption }>
```

Tools access context via `getToolContext()` — properly isolated per request.

---

## 7. CODE QUALITY REPORT

### 7.1 Type Safety — NEEDS WORK

**31+ instances of `any` type across the codebase:**

| File | Count | Risk |
|------|-------|------|
| `composio.ts` | 10+ | HIGH — External API responses unvalidated |
| `tools/memory.ts` | 8+ | MEDIUM — Memory API responses unvalidated |
| `agent.ts` | 4 | HIGH — Core logic type safety gaps |
| `tools/sandbox.ts` | 2 | MEDIUM — Process management |
| `boot/mcp.ts` | 2 | MEDIUM — MCP integration |

### 7.2 Error Handling — CRITICAL

**30+ swallowed errors (empty catch blocks or `.catch(() => {})`):**

| Pattern | Count | Files | Severity |
|---------|-------|-------|----------|
| `catch {}` (empty) | 15+ | cli.ts, config.ts, db.ts, soul.ts, events.ts | HIGH |
| `.catch(() => {})` | 10+ | agent.ts, telegram.ts, dashboard.ts | HIGH |
| Generic catch (no type check) | 5+ | composio.ts, memory.ts | MEDIUM |

**Worst offenders:**
- `agent.ts:398` — Memory ingestion silently dropped: `.catch(() => {})`
- `events.ts:23` — Event listener crashes hidden: `try { fn(name, data); } catch {}`
- `db.ts:148-149` — SQL migration errors silently ignored
- `cli.ts` — 7 empty catch blocks in setup flow

### 7.3 Logging — INCONSISTENT

Three different approaches used simultaneously:
1. `console.log()` / `console.warn()` (dominant)
2. `log()` from `log.ts` (sparse — memory, proactive)
3. `chalk` colored output (CLI only)

**Issues:**
- No structured JSON logging for production
- No log levels consistently applied
- Tool arguments logged without sanitization (credential leak risk)
- No request tracing / correlation IDs

### 7.4 Code Duplication

| Pattern | Locations | Fix |
|---------|-----------|-----|
| Safe path validation | `tools/filesystem.ts`, `tools/files.ts` | Extract shared utility |
| Stream reading (stdout/stderr) | `tools/sandbox.ts` (2 identical blocks) | Extract `readStream()` |
| Error handling in Telegram | `channels/telegram.ts` (5 identical blocks) | Extract `handleAgentReply()` |
| Blocked file patterns | `tools/filesystem.ts`, `tools/files.ts` | Shared constant |

### 7.5 Dead Code / Unused Patterns

- `scripts/build.ts` — Build script exists but unused in current workflow
- `events.ts` — Event bus defined but barely used (line 23 has single subscriber)
- `splitOnDelimiter()` — Exported from agent.ts but only used internally
- Sub-agent `wasKilled` variable — Always true after success (unreachable branch)

---

## 8. SECURITY AUDIT

### Strengths

| Control | Implementation | Status |
|---------|---------------|--------|
| **File path containment** | `safePath()` with realpath resolution | Good |
| **Blocked file patterns** | .env, .ssh, .aws, credentials, keys, etc. | Good |
| **Sandbox isolation** | Docker: 512MB RAM, 0.5 CPU, no network | Good |
| **Secrets management** | .env only, never serialized to config | Good |
| **Telegram access control** | Allow-list + admin IDs | Good |
| **Webhook verification** | Secret token header validation | Good |
| **SQL injection prevention** | Prepared statements throughout | Good |
| **Sub-agent recursion prevention** | Tool allowlist + always-blocked list | Good |

### Vulnerabilities Found

| ID | Severity | Issue | Location |
|----|----------|-------|----------|
| SEC-01 | HIGH | System prompt injection via user profile | agent.ts:213-220 |
| SEC-02 | HIGH | Potential secrets in logs (tool args logged unsanitized) | agent.ts:345 |
| SEC-03 | MEDIUM | Path traversal edge case (realpath failure in catch) | filesystem.ts:41 |
| SEC-04 | MEDIUM | No global rate limiting (only per-chat in Telegram) | Multiple |
| SEC-05 | MEDIUM | Webhook secret optional (should be required for webhook mode) | config.ts |
| SEC-06 | LOW | No API authentication on /health endpoint | boot/server.ts |
| SEC-07 | LOW | File size not validated before PDF parsing | telegram.ts:298 |
| SEC-08 | LOW | MCP servers connected without additional auth | boot/mcp.ts |

### Recommendations

1. **SEC-01 FIX:** Escape/template user profile data before system prompt injection
2. **SEC-02 FIX:** Add argument redaction for sensitive tool parameters
3. **SEC-04 FIX:** Implement global request rate limiting at HTTP layer
4. **SEC-05 FIX:** Make webhook secret mandatory when webhook mode is enabled

---

## 9. PERFORMANCE PROFILE

### Latency Benchmarks

| Operation | Typical Latency | Bottleneck |
|-----------|-----------------|-----------|
| Full boot | ~5-10s | MCP server connections |
| Config load | <100ms | File I/O + Zod validation |
| DB init + migrations | <500ms | SQLite pragma setup |
| Tier classification | <1ms | Regex keyword matching |
| LLM call (fast tier) | ~3-5s | Network + Gemini inference |
| LLM call (deep tier) | ~5-10s | Network + Claude inference |
| Memory recall | ~1-2s | Supermemory API |
| Web search | ~2-3s | Exa API |
| Tool execution (local) | <100ms | In-process |

### Memory Usage

| State | Usage | Notes |
|-------|-------|-------|
| Base runtime | ~80-100 MB | Bun + core modules |
| Typical operating | ~150-200 MB | With active sessions |
| Peak (sub-agents) | ~200-300 MB | Multiple concurrent agents |
| SQLite DB (typical) | ~50 MB | After months of use |

### Performance Issues Found

| ID | Severity | Issue | Location |
|----|----------|-------|----------|
| PERF-01 | MEDIUM | `readFileSync` blocks event loop for file sends | telegram.ts:247 |
| PERF-02 | MEDIUM | SQLite VACUUM is synchronous (blocks all requests) | index.ts:261 |
| PERF-03 | MEDIUM | Token estimation uses crude chars/4 heuristic | agent.ts:116 |
| PERF-04 | LOW | Memory extraction LLM call adds 3-5s latency | memory.ts:73-98 |
| PERF-05 | LOW | PDF parsing via dynamic import on every PDF | telegram.ts:298 |
| PERF-06 | LOW | Sandbox stdout buffered fully before truncation | sandbox.ts:96 |
| PERF-07 | LOW | N+1 API calls in memory ingestion | memory.ts:231-301 |

---

## 10. TESTING & QA STATUS

### Current State: MINIMAL

| Test Type | Status | Coverage |
|-----------|--------|----------|
| **Unit Tests** | None | 0% |
| **Integration Tests** | None | 0% |
| **E2E Tests** | None | 0% |
| **Benchmarks** | 44 tests / 13 categories | Behavioral coverage |
| **CI/CD** | Release-only | No PR checks |

### Benchmark Suite (What Exists)

The project has a **novel LLM-judge-powered benchmark system** instead of traditional tests:

- **44 test cases** across 13 categories (chat, memory, search, scheduling, file I/O, sandbox, multi-turn, tool chaining, composio, sub-agents, tier escalation, error recovery, edge cases)
- **Hybrid grading:** Programmatic checks (free) + LLM judge (~$0.001/test)
- **Multi-dimensional scoring:** Correctness (40%), Tool Usage (25%), Response Quality (20%), Tone (15%)
- **Cost per full run:** ~$1.24
- **Pass threshold:** 6.0/10

### What's NOT Tested

- Database operations (migrations, schema, transactions)
- Config loading/validation edge cases
- Permission/security checks
- Rate limiting behavior
- Individual tool parsing/validation
- Error handling paths (all those catch blocks)
- MCP server connections
- Concurrent access patterns
- Memory leak scenarios

### Recommended Testing Strategy

```
Tier 1: FAST (pre-commit) — Unit tests (<10s)
  → config validation, router logic, path sanitization, cron parsing

Tier 2: MEDIUM (PR) — Integration tests (<60s)
  → tool chains, DB operations, memory + schedule together

Tier 3: SLOW (release) — Benchmarks + E2E (<5min, gated)
  → full 44-test benchmark suite with pass/fail gates
```

---

## 11. WHAT SHOULD CHANGE

### 11.1 Critical Changes (Do First)

| Change | Why | Effort |
|--------|-----|--------|
| **Replace all empty catch blocks with proper logging** | 30+ silent failures make debugging impossible | 1 day |
| **Replace all `any` types with proper interfaces** | 31+ type safety gaps, especially in composio.ts and memory.ts | 2 days |
| **Add structured JSON logging** | Current logging is unparseable in production (Railway) | 1 day |
| **Fix system prompt injection** | User profile data interpolated directly into system prompt | 0.5 day |
| **Add tool argument redaction in logs** | API keys could leak in tool call logs | 0.5 day |

### 11.2 Architecture Changes (High Impact)

| Change | Why | Effort |
|--------|-----|--------|
| **Make pricing/models configurable** | Currently hardcoded in router.ts, stale pricing data | 1 day |
| **Add global rate limiting** | Only per-chat in Telegram, no HTTP-level protection | 1 day |
| **Persist pending state to SQLite** | Files, sub-agent results lost on crash (in-memory only) | 1 day |
| **Standardize tool output format** | Each tool returns different shapes (`{ success }` vs `{ queued }` vs raw) | 1 day |
| **Make circuit breaker configurable** | Hardcoded thresholds (3 failures, 60-120s reset) | 0.5 day |

### 11.3 Quality of Life Changes

| Change | Why | Effort |
|--------|-----|--------|
| **Make tier escalation step configurable** | Hardcoded at step 5, can't tune | 0.5 hr |
| **Make message retention days configurable** | Hardcoded at 90 days | 0.5 hr |
| **Make built-in task schedules configurable** | "sun 09:00" and "08:00" hardcoded | 0.5 hr |
| **Add exponential backoff to MCP reconnect** | Currently immediate retry, could spam logs | 1 hr |
| **Add confirmation for /clear command** | Users can accidentally clear history | 0.5 hr |

---

## 12. WHAT SHOULD BE REMOVED

| Item | Reason | Risk |
|------|--------|------|
| `scripts/build.ts` | Unused — builds happen via Bun directly | None |
| `events.ts` (if truly unused) | Event bus defined but barely utilized — adds complexity with no value | Low — verify no active subscribers |
| `"gpt-5.3-codex"` in PRICING | Model doesn't exist, misleading pricing entry | None |
| `splitOnDelimiter` export | Only used internally in agent.ts, unnecessary export | None |
| Dynamic `import("pdf-parse")` | Should be top-level import, not per-PDF dynamic import | None |
| Commented-out DALL-E detection in image.ts | Incomplete code, should be finished or removed | None |

---

## 13. WHAT SHOULD BE CONSOLIDATED

### 13.1 Merge Duplicated Code

| What | From | To | Benefit |
|------|------|----|---------|
| Path validation logic | `tools/filesystem.ts` + `tools/files.ts` | Shared `src/security.ts` utility | Single source of truth, fewer bugs |
| Blocked file patterns | `tools/filesystem.ts` + `tools/files.ts` | Shared constant in `src/security.ts` | Consistency |
| Stream reading pattern | `tools/sandbox.ts` (2 blocks) | `readProcessStream()` utility | DRY, testable |
| Telegram error handling | 5 identical blocks in `telegram.ts` | `handleAgentReply()` helper | 50% less code |

### 13.2 Consolidate Configuration

| What | Current State | Target |
|------|--------------|--------|
| Model IDs | Hardcoded in router.ts + config.ts | All in config, router reads from config |
| Pricing data | Hardcoded in router.ts | Config-driven or fetched from OpenRouter API |
| Timeout values | Mixed hardcoded + config | All in config with sensible defaults |
| Rate limit params | Hardcoded in telegram.ts | Config-driven |
| Circuit breaker params | Hardcoded in memory.ts + agent.ts | Config-driven |

### 13.3 Consolidate Logging

| Current | Lines | Target |
|---------|-------|--------|
| `console.log()` | ~50 call sites | `log("category", ...)` everywhere |
| `console.warn()` | ~15 call sites | `log.warn("category", ...)` everywhere |
| `console.error()` | ~10 call sites | `log.error("category", ...)` everywhere |
| `chalk.*` in CLI | ~20 call sites | Keep for CLI only |

---

## 14. WHAT'S MISSING

### 14.1 Testing Infrastructure

| Need | Priority | Effort |
|------|----------|--------|
| Unit tests (50-100 tests) | HIGH | 2-3 days |
| Integration tests (20-30 tests) | HIGH | 3-4 days |
| Database tests | MEDIUM | 2-3 days |
| CI/CD PR checks | MEDIUM | 0.5 day |
| Benchmark pass/fail gates in CI | MEDIUM | 0.5 day |
| E2E tests (5-10 critical paths) | LOW | 2-3 days |

### 14.2 Observability

| Need | Priority | Effort |
|------|----------|--------|
| Structured JSON logging | HIGH | 1 day |
| Request tracing / correlation IDs | MEDIUM | 1 day |
| Metrics collection (Prometheus-style) | MEDIUM | 2 days |
| Tool call audit logging | MEDIUM | 1 day |
| Performance dashboard | LOW | 2 days |

### 14.3 Resilience

| Need | Priority | Effort |
|------|----------|--------|
| Retry with exponential backoff (Exa, GitHub, Composio) | HIGH | 1 day |
| Global request rate limiting | HIGH | 1 day |
| Per-user cost budgets/limits | MEDIUM | 1 day |
| Graceful degradation UI indicators | MEDIUM | 1 day |
| Automatic backup before migrations | MEDIUM | 0.5 day |
| Shutdown timeout (prevent hangs) | LOW | 0.5 day |

### 14.4 Features

| Need | Priority | Effort |
|------|----------|--------|
| Tool discovery command (list available tools) | LOW | 0.5 day |
| Memory TTL / auto-expiry | LOW | 1 day |
| Skill versioning | LOW | 1 day |
| Sub-agent resume after restart | LOW | 2 days |

### 14.5 Documentation

| Need | Priority | Effort |
|------|----------|--------|
| Testing strategy document | MEDIUM | 0.5 day |
| Development setup guide | MEDIUM | 0.5 day |
| Contributing guide | LOW | 0.5 day |
| Architecture Decision Records | LOW | 1 day |
| Troubleshooting guide | LOW | 0.5 day |

---

## 15. PRIORITIZED ACTION PLAN

### Phase 1: HARDEN (Week 1-2)

**Goal:** Fix critical code quality issues that will compound

1. **Replace all empty catch blocks** with proper error logging
   - Touch: cli.ts, config.ts, db.ts, soul.ts, events.ts, agent.ts, telegram.ts
   - Pattern: `catch (err) { log.error("category", "what failed", err); }`

2. **Replace all `any` types** with proper interfaces
   - Focus: composio.ts (10+), memory.ts (8+), agent.ts (4)
   - Create `src/types.ts` for shared interfaces

3. **Consolidate logging** to single structured approach
   - Enhance `log.ts` with JSON mode for production
   - Replace all `console.*` calls with `log.*`
   - Add request ID propagation

4. **Fix security issues**
   - SEC-01: Template user profile in system prompt
   - SEC-02: Redact tool arguments in logs
   - SEC-05: Make webhook secret required for webhook mode

### Phase 2: TEST (Week 3-4)

**Goal:** Establish testing baseline

5. **Add unit tests** for deterministic modules
   - router.ts (tier classification, intent detection)
   - config.ts (validation, env overrides)
   - time.ts (cron parsing)
   - tools/filesystem.ts (path sanitization)
   - db.ts (CRUD operations)
   - Target: 50+ tests

6. **Add CI/CD PR checks**
   - Run unit tests on every PR
   - Add benchmark pass/fail threshold
   - Block merge on test failure

7. **Add integration tests** for critical paths
   - Full tool chains
   - Database transactions
   - Memory + schedule together
   - Target: 20+ tests

### Phase 3: CONSOLIDATE (Week 5-6)

**Goal:** Reduce duplication and configuration sprawl

8. **Extract shared utilities**
   - `src/security.ts` — Path validation, blocked patterns
   - `src/retry.ts` — Exponential backoff helper
   - `src/stream.ts` — Process stream reading

9. **Consolidate configuration**
   - Move all hardcoded values to config
   - Add config validation for model IDs
   - Make all timeouts/thresholds configurable

10. **Standardize tool output format**
    - Consistent `{ success, data?, error? }` shape
    - Shared response builder function

### Phase 4: ENHANCE (Week 7-8)

**Goal:** Add missing infrastructure

11. **Add retry logic** to all external API calls
    - Exponential backoff with jitter
    - Circuit breaker for all external services

12. **Add global rate limiting** at HTTP layer
13. **Add per-user cost budgets**
14. **Persist in-memory state** (pending files, sub-agent results) to SQLite
15. **Add request tracing** with correlation IDs

---

## 16. ISSUE REGISTRY

### By Severity

#### CRITICAL (Fix Immediately)

| ID | File | Line | Issue |
|----|------|------|-------|
| ERR-01 | agent.ts | 398 | Memory ingestion silently dropped: `.catch(() => {})` |
| SEC-01 | agent.ts | 213-220 | System prompt injection via user profile |
| SEC-02 | agent.ts | 345 | Tool arguments logged without sanitization |
| TYPE-01 | composio.ts | 81 | `as any` JSON parsing — API response unvalidated |
| ERR-02 | events.ts | 23 | Event listener crashes hidden: `catch {}` |

#### HIGH (Fix This Sprint)

| ID | File | Line | Issue |
|----|------|------|-------|
| ERR-03 | db.ts | 148-149 | SQL migration errors silently ignored |
| TYPE-02 | agent.ts | 414 | `cron: null as any` type bypass |
| TYPE-03 | agent.ts | 576-577 | Usage tokens cast as `any` — billing corruption risk |
| ERR-04 | cli.ts | Multiple | 7 empty catch blocks in setup flow |
| PERF-01 | telegram.ts | 247 | `readFileSync` blocks event loop |
| PRICE-01 | router.ts | 104-113 | Stale/wrong pricing data ("gpt-5.3-codex" doesn't exist) |
| CONFIG-01 | router.ts | 97-100 | Model IDs and failover chains hardcoded in code |

#### MEDIUM (Fix This Month)

| ID | File | Line | Issue |
|----|------|------|-------|
| PERF-02 | index.ts | 261 | SQLite VACUUM is synchronous, blocks requests |
| PERF-03 | agent.ts | 116 | Token estimation crude (chars/4) |
| SEC-03 | filesystem.ts | 41 | Path traversal edge case on realpath failure |
| SEC-04 | Multiple | — | No global HTTP rate limiting |
| SEC-05 | config.ts | — | Webhook secret optional (should be required) |
| DUP-01 | filesystem.ts + files.ts | — | Duplicated path validation |
| DUP-02 | sandbox.ts | 90-98, 202-210 | Duplicated stream reading |
| LOG-01 | Multiple | — | Inconsistent logging (3 different approaches) |
| STATE-01 | subagent.ts | 32 | In-memory Map lost on crash |
| STATE-02 | tools/index.ts | — | Pending files lost on crash |

#### LOW (Fix When Convenient)

| ID | File | Line | Issue |
|----|------|------|-------|
| DEAD-01 | scripts/build.ts | — | Unused build script |
| DEAD-02 | events.ts | — | Event bus barely utilized |
| DEAD-03 | router.ts | 108 | "gpt-5.3-codex" pricing entry for non-existent model |
| PERF-04 | telegram.ts | 298 | Dynamic import of pdf-parse on every PDF |
| CONFIG-02 | index.ts | 82-110 | Hardcoded built-in task schedules |
| CONFIG-03 | agent.ts | 336 | Hardcoded tier escalation at step 5 |
| CONFIG-04 | agent.ts | 115 | Hardcoded 6000-token history budget |
| UX-01 | telegram.ts | — | /clear command has no confirmation |

---

## APPENDIX: QUICK REFERENCE

### Environment Variables

```
REQUIRED:
  KODA_OPENROUTER_API_KEY    # LLM provider
  KODA_TELEGRAM_TOKEN         # Telegram bot (unless cli-only)

OPTIONAL:
  KODA_SUPERMEMORY_API_KEY   # Semantic memory
  KODA_EXA_API_KEY           # Web search
  KODA_COMPOSIO_API_KEY      # Email/Calendar/GitHub
  KODA_GITHUB_TOKEN          # GitHub API (higher rate limits)
  KODA_TELEGRAM_WEBHOOK_URL  # Webhook mode
  KODA_TELEGRAM_WEBHOOK_SECRET  # Webhook verification
  KODA_TELEGRAM_ALLOW_FROM   # Comma-separated user IDs
  KODA_TELEGRAM_ADMIN_IDS    # Admin notification recipients
  KODA_MODE                  # "private" or "cli-only"
  KODA_ENV                   # "production" or "development"

AUTO-INJECTED (Railway):
  RAILWAY_SERVICE_ID
  RAILWAY_DEPLOYMENT_ID
  RAILWAY_GIT_BRANCH
  RAILWAY_GIT_COMMIT_SHA
```

### Key Commands

```bash
bun start                    # Production run
bun run dev                  # Watch mode (hot-reload)
bun run cli                  # CLI-only mode
bun run koda setup           # Interactive setup wizard
bun run koda doctor          # Health check
bun run bench                # Run benchmarks
docker compose up -d         # Docker deployment
```

### Telegram Commands

```
/help      — List commands
/clear     — Reset conversation
/usage     — Token usage & costs
/status    — System health
/debug     — Detailed diagnostics (admin)
/deep      — Force deep tier
/fast      — Force fast tier
/recap     — Summarize conversation
/model     — View/change models
/memories  — Manage memories
```

---

*End of audit. Generated by 6-agent parallel analysis covering: project structure, core logic, tools, integrations, code quality, and testing infrastructure.*
