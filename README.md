<h1 align="center">koda</h1>

<p align="center">
  <img src="https://img.shields.io/badge/v1.0-stable-10b981?style=flat-square" alt="v1.0" />
  <img src="https://img.shields.io/badge/bun-runtime-f472b6?style=flat-square" alt="Bun" />
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/bench-55%2F55_passing-10b981?style=flat-square" alt="55/55" />
  <img src="https://img.shields.io/badge/files-19-white?style=flat-square" alt="19 files" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="MIT" />
</p>

<p align="center">
  a personal ai that actually feels personal.<br/>
  <sub>remembers everything. runs code. browses the web. sends voice notes. texts like a real one.</sub>
</p>

---

most ai assistants feel like talking to a help desk. koda feels like texting your smartest friend — the one who remembers your birthday, looks stuff up without being asked, runs your scripts at 3am, and never says "as an AI language model."

koda is a long-running assistant that connects to telegram or a local cli, routes every message through the right model for the job, remembers your preferences via semantic memory, creates its own skills, schedules reminders, browses the web, executes code locally, and replies with voice notes.

built on bun. runs on a $5 vps. 19 files. no bloat.

## why koda

**most frameworks give you a chatbot. koda gives you a second brain.**

| problem | how koda solves it |
|---|---|
| llm costs spiral out of control | 3-tier auto-routing — greetings cost $0.075/M tokens, only reasoning tasks hit opus at $25/M. the router picks the cheapest model that can handle the job. |
| assistants forget everything between sessions | semantic memory via supermemory with circuit breaker fallback to sqlite. koda remembers what you told it last month. |
| "let me think about that" for simple questions | fast tier responds in <1s. model escalation kicks in automatically if the task turns out to be harder than expected — starts cheap, upgrades mid-conversation. |
| voice feels bolted on | native voice pipeline — groq whisper for STT, openai tts-1 for synthesis. send a voice note, get a voice note back. no sdk dependencies, just fetch. |
| sandbox execution is expensive | local `Bun.spawn()` with auto-background after 10s. no cloud sandbox bills. blocked commands list for safety. |
| personality feels corporate | fully editable soul.md with hot-reload. koda writes in lowercase, uses slang, splits messages naturally. texts like a person, not a product. |
| tools are static | skills system — koda reads, creates, and loads its own SKILL.md files at runtime. it literally teaches itself new abilities. |
| testing is an afterthought | 55-case deterministic benchmark suite with 100% pass rate. llm-judged quality tests for personality and safety. ships with `bun run bench`. |

## architecture

```
you (telegram / cli / voice)
         |
         v
   ┌──────────┐
   │  router   │──── fast (flash lite, $0.075/M)
   │  3-tier   │──── standard (gemini 3 flash, $0.5/M)
   │  classify │──── deep (claude opus, $5/M)
   └──────────┘
         |
         v
   ┌──────────┐     ┌──────────────────────────┐
   │  agent    │────>│  generateText tool loop   │
   │  core     │     │  prepareStep: escalate    │
   └──────────┘     │  onStepFinish: track      │
         |          │  stopWhen: 30 steps max    │
         v          └──────────────────────────┘
   ┌──────────────────────────────┐
   │  tools                       │
   │  memory · search · exec     │
   │  filesystem · browser       │
   │  schedule · skills · soul   │
   └──────────────────────────────┘
         |
         v
   ┌──────────┐
   │  sqlite   │  messages, tasks, usage,
   │  wal mode │  learnings, state
   └──────────┘
```

no message bus. no middleware pipeline. no AsyncLocalStorage. the agent calls `generateText` with tools, the ai sdk handles the loop, and channels call `runAgent()` directly. that's it.

the old prototype had 46 files, a 12-stage pipeline, 4-tier routing with 8-dimension weighted scoring, typed message bus, and cloud sandboxing. we threw it all away and rebuilt from scratch. the result is faster, cheaper, and fits in your head.

## quick start

```bash
# install
bun install

# interactive setup (creates config + .env)
bun run src/index.ts setup

# verify everything works
bun run src/index.ts doctor

# run (telegram + proactive)
bun start

# or cli-only mode
bun run cli
```

### manual config

```bash
cp .env.example .env           # add your api keys
cp config/config.example.json config/config.json  # tweak models, timezone, features
```

**required keys:**
- `KODA_OPENROUTER_API_KEY` — llm routing (all 3 tiers)
- `KODA_SUPERMEMORY_API_KEY` — semantic memory

**optional keys:**
- `KODA_TELEGRAM_TOKEN` — telegram bot (required unless cli-only mode)
- `KODA_TAVILY_API_KEY` — web search
- `KODA_GROQ_API_KEY` — voice transcription (whisper)
- `KODA_OPENAI_API_KEY` — voice synthesis (tts-1)

## benchmarks

```bash
bun run bench                    # deterministic only (free, <30ms)
bun run bench:judge              # llm-judged quality (~$0.25)
bun run bench:all                # everything
bun run bench:ci                 # json output for ci
```

```
╔══════════════════════════════════════════════════════════════╗
║              A S S I S T A N T B E N C H                    ║
╚══════════════════════════════════════════════════════════════╝

DETERMINISTIC — 55/55 passed (27ms)
├── classify       30/30  100%   3-tier routing + intent detection
├── ack            10/10  100%   acknowledgement decisions
├── time            5/5   100%   cron parsing + timezone math
└── timezone       10/10  100%   IANA timezone validation

LLM-JUDGE — 15/15 passed (~$0.24)
├── quality         3/3   100%   helpfulness, accuracy, conciseness
├── personality     4/4   100%   tone, style, boundary adherence
├── safety          3/3   100%   jailbreak resistance
├── tool_use        3/3   100%   tool selection accuracy
└── edge_case       2/2   100%   ambiguous + emotional inputs

Total: 70 cases · 100.0% pass rate · 100.0% avg score
```

## project structure

```
koda/
├── src/
│   ├── index.ts              entry point + health server
│   ├── config.ts             zod-validated 3-tier config
│   ├── db.ts                 sqlite with 5 tables
│   ├── router.ts             rule-based classifier + pricing
│   ├── agent.ts              generateText tool loop core
│   ├── time.ts               cron parsing + timezone utils
│   ├── proactive.ts          30s tick loop + heartbeat
│   ├── cli.ts                setup / doctor / upgrade / version
│   ├── channels/
│   │   ├── repl.ts           local cli channel
│   │   └── telegram.ts       grammy bot + voice pipeline
│   └── tools/
│       ├── index.ts          tool composition + context
│       ├── memory.ts         supermemory + circuit breaker
│       ├── search.ts         tavily web search
│       ├── filesystem.ts     workspace-scoped file ops
│       ├── exec.ts           local code execution
│       ├── browser.ts        stagehand headless browser
│       ├── schedule.ts       reminders + recurring tasks
│       ├── skills.ts         self-evolving skill system
│       └── soul.ts           personality loader + editor
├── bench/                    55+ deterministic + llm-judge cases
├── config/                   soul.md, config.example.json
├── Dockerfile                production container
└── railway.toml              one-click railway deploy
```

**19 files · 2,862 lines of typescript · 8 tool modules · 70 benchmark cases**

## models

koda auto-routes every message to the cheapest model that can handle it.

| tier | when | default model | cost (per 1M tokens) |
|------|------|---------------|---------------------|
| **fast** | greetings, simple questions, short replies | gemini 2.5 flash lite | $0.075 in / $0.30 out |
| **standard** | tools, code, research, scheduling | gemini 3 flash | $0.50 in / $3.00 out |
| **deep** | formal reasoning, proofs, deep analysis | claude opus 4.6 | $5.00 in / $25.00 out |

**model escalation**: if the agent is still working after 5 tool steps on fast/standard, it automatically upgrades to the next tier. starts cheap, scales up only when needed.

**failover chains**: each tier has a fallback model list via openrouter's `models` array. if deepseek goes down at 2am, koda automatically falls over to the next model in the chain. zero downtime, zero code changes.

all models are configurable. swap in any openrouter-supported model.

## tools

| tool | what it does |
|------|-------------|
| **remember** / **recall** | semantic memory — stores facts, retrieves relevant context. supermemory with sqlite fallback when circuit breaker trips. |
| **webSearch** / **extractUrl** | tavily-powered search + page content extraction. |
| **readFile** / **writeFile** / **listFiles** | workspace-scoped filesystem. blocked patterns for .env, secrets, node_modules. |
| **exec** / **process** | local code execution via Bun.spawn. auto-backgrounds after 10s. poll, stream logs, or kill running processes. |
| **browseUrl** / **browserAct** / **browserExtract** / **browserScreenshot** / **browserClose** | stagehand headless browser. navigate, click, fill forms, extract data, take screenshots. |
| **createReminder** / **createRecurringTask** / **listTasks** / **deleteTask** | timezone-aware scheduling with cron-style recurrence. |
| **skills** | list, load, or create SKILL.md files. koda teaches itself new abilities at runtime. |
| **getSoul** / **updateSoul** | read or rewrite personality sections. hot-reloaded. |

## deploy

### docker

```bash
# with docker compose (recommended)
docker compose up -d

# or standalone
docker build -t koda .
docker run -d --env-file .env -p 3000:3000 koda
```

### railway

click deploy. set env vars. done. health checks at `/health`.

### vps

```bash
bun install --production
bun start
```

runs on anything that runs bun. 128mb ram is plenty.

## tech stack

| layer | tech |
|-------|------|
| runtime | [bun](https://bun.sh) |
| language | typescript 5.9 (strict) |
| ai | [vercel ai sdk v6](https://sdk.vercel.ai) |
| llm routing | [openrouter](https://openrouter.ai) — 3-tier auto-routing |
| memory | [supermemory](https://supermemory.ai) + sqlite fallback |
| telegram | [grammy](https://grammy.dev) |
| database | sqlite via bun:sqlite (wal mode) |
| validation | [zod v4](https://zod.dev) |
| browser | [stagehand](https://github.com/browserbase/stagehand) |
| search | [tavily](https://tavily.com) |
| voice stt | [groq](https://groq.com) whisper (raw fetch) |
| voice tts | [openai](https://openai.com) tts-1 (raw fetch) |
| cli ui | [@clack/prompts](https://github.com/bombshell-dev/clack) + chalk + ora |

## the v1 rebuild

the prototype was over-engineered. 46 files, 5,400 lines, a 12-stage middleware pipeline, 4-tier routing with 8-dimension weighted scoring, AsyncLocalStorage context threading, typed message bus, E2B cloud sandboxing, and subsystems for focus mode, outcome learning, and budget scoring that nobody used.

we gutted it. rewrote from scratch. kept the proven patterns (semantic memory, skills, proactive scheduling, soul personality), dropped everything that added complexity without adding value.

| | before (v0) | after (v1) |
|---|---|---|
| files | 46 | 19 |
| lines | 5,400 | 2,862 |
| pipeline | 12-stage middleware | single generateText loop |
| routing | 4-tier, 8-dimension weighted | 3-tier, keyword rules |
| context | AsyncLocalStorage | closure |
| sandbox | E2B cloud ($$$) | local Bun.spawn (free) |
| message passing | typed MessageBus | direct function calls |
| voice | none | full STT + TTS pipeline |
| cli | 12 files, custom UI | 1 file, @clack/prompts |
| benchmark | 113 cases (many untestable) | 55+15 focused cases, 100% pass |

less code. more features. cheaper to run. easier to understand.

## license

MIT
