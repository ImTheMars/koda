<h1 align="center">koda</h1>

<p align="center">
  <img src="https://img.shields.io/badge/v2.0.0-stable-10b981?style=flat-square" alt="v2.0.0" />
  <img src="https://img.shields.io/badge/bun-runtime-f472b6?style=flat-square" alt="Bun" />
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/bench-74%20deterministic-10b981?style=flat-square" alt="74 cases" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="MIT" />
</p>

<p align="center">
  a personal ai that actually feels personal.<br/>
  <sub>remembers everything. browses the web. schedules tasks. delegates to sub-agents. texts like a real one.</sub>
</p>

---

a long-running ai assistant that connects to telegram or a local cli, routes every message through the right model for the job, remembers your preferences via semantic memory, creates its own skills, schedules reminders, browses the web, spawns sub-agents for parallel work, and replies like a real person.

built on bun. runs on a $5 vps. no bloat.

## architecture

```
you (telegram / cli)
         |
         v
   +----------+
   |  router   |---- fast (gemini 3 flash, $0.50/M)
   |  2-tier   |---- deep (claude sonnet 4.6, $3/M)
   |  classify |
   +----------+
         |
         v
   +----------+     +--------------------------+
   |  agent    |---->|  generateText tool loop   |
   |  core     |     |  prepareStep: escalate    |
   +----------+     |  onStepFinish: track      |
         |          |  stopWhen: 30 steps max    |
         v          +--------------------------+
   +------------------------------+
   |  tools                       |
   |  memory - search - sandbox  |
   |  filesystem - schedule      |
   |  skills - soul - status     |
   |  subagent - skillshop       |
   +------------------------------+
         |
         v
   +----------+
   |  sqlite   |  messages, tasks, usage,
   |  wal mode |  state, subagents,
   +----------+  vector_memories
```

the agent calls `generateText` or `streamText` with tools, the ai sdk handles the loop, and channels call `runAgent()` or `streamAgent()` directly. tool context (userId, chatId, channel) is threaded via AsyncLocalStorage so every tool knows who it's serving without passing state around.

model escalation: if the agent is still working after 5 tool steps on fast tier, it automatically upgrades to deep. starts cheap, scales up only when needed.

failover chains: each tier has a fallback model list via openrouter's `models` array. if the primary model is down, koda falls over to the next model automatically.

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
cp config/config.example.json ~/.koda/config.json
```

create `~/.koda/.env`:

```
KODA_OPENROUTER_API_KEY=sk-or-...
KODA_TELEGRAM_TOKEN=123456:ABC...     # required unless cli-only
KODA_EXA_API_KEY=...                  # optional — web search + skill shop
KODA_SUPERMEMORY_API_KEY=...          # optional — cloud memory (local embeddings work without it)
```

## config reference

all fields are optional except `openrouter.apiKey` (via env var).

| section | field | default | description |
|---------|-------|---------|-------------|
| `mode` | | `"private"` | `"private"` (telegram) or `"cli-only"` |
| `owner` | `id` | `"owner"` | owner user ID |
| `openrouter` | `fastModel` | `google/gemini-3-flash-preview` | fast tier model |
| `openrouter` | `deepModel` | `anthropic/claude-sonnet-4.6` | deep tier model |
| `agent` | `maxSteps` | `30` | max tool loop steps |
| `agent` | `maxTokens` | `8192` | max output tokens per turn |
| `agent` | `temperature` | `0.7` | LLM temperature |
| `scheduler` | `timezone` | `America/Los_Angeles` | IANA timezone for scheduling |
| `proactive` | `tickIntervalMs` | `30000` | scheduler tick interval |
| `features` | `scheduler` | `true` | enable/disable proactive scheduler |
| `features` | `debug` | `false` | enable debug logging |
| `subagent` | `timeoutMs` | `90000` | sub-agent timeout |
| `subagent` | `maxSteps` | `10` | sub-agent max steps |
| `ollama` | `enabled` | `false` | use local Ollama for fast tier |
| `ollama` | `baseUrl` | `http://localhost:11434` | Ollama server URL |
| `ollama` | `model` | `llama3.2` | Ollama model name |
| `embeddings` | `enabled` | `false` | local vector memory via Ollama |
| `mcp` | `servers` | `[]` | MCP server configurations (stdio, sse, http) |

## tools

| tool | what it does |
|------|-------------|
| **remember** / **recall** | semantic memory — stores facts, retrieves relevant context. supermemory cloud + local sqlite vector fallback. |
| **webSearch** / **extractUrl** | exa-powered web search + page content extraction. |
| **readFile** / **writeFile** / **listFiles** | workspace-scoped filesystem. blocked patterns for .env, secrets, node_modules. |
| **runSandboxed** | isolated Docker container execution with resource limits (512MB RAM, 0.5 CPU, no network). |
| **createReminder** / **createRecurringTask** / **listTasks** / **deleteTask** | timezone-aware scheduling with natural language ("every Monday at 9am") and cron format. |
| **skills** | list, load, or create SKILL.md files. koda teaches itself new abilities at runtime. |
| **skillShop** | search and install community skills from GitHub via Exa. |
| **getSoul** / **updateSoul** | read or rewrite personality sections. hot-reloaded without restart. |
| **systemStatus** | uptime, memory usage, circuit breaker state, today's cost, next scheduled task. |
| **spawnAgent** | delegate sub-tasks to isolated child agents with filtered toolsets. multiple spawns run concurrently. |

## features

- **dashboard** — real-time web UI at `/` with usage stats, skills, tasks, sub-agent activity, and RAM graph. SSE-powered live updates.
- **MCP** — connect external tool servers (Notion, GitHub, etc.) via `@ai-sdk/mcp`. stdio, SSE, and HTTP transports. auto-reconnect on crash.
- **sub-agents** — spawn focused child agents for parallel work. isolated sessions, filtered tools, config-driven limits. addressable via `@AgentName: ...`.
- **skill shop** — search and install community skills from GitHub. safety scoring before install.
- **docker sandbox** — run untrusted code in isolated containers with hard resource limits.
- **local embeddings** — optional vector memory via Ollama for fully offline operation.
- **Ollama** — use local LLMs for fast tier when configured. falls back to OpenRouter when unavailable.
- **soul personality** — editable `soul.md` + `soul.d/*.md` with filesystem watcher for hot-reload.

## database

7 tables in SQLite (WAL mode):

| table | purpose |
|-------|---------|
| `messages` | conversation history per session |
| `tasks` | reminders + recurring scheduled tasks |
| `usage` | per-request cost and token tracking |
| `state` | key-value store (schema version, seeds) |
| `subagents` | sub-agent spawn records |
| `vector_memories` | local embedding vectors |
| `learnings` | legacy (unused, kept for backward compatibility) |

## benchmarks

```bash
bun run bench                    # deterministic only (free, <30ms)
bun run bench:judge              # llm-judged quality (~$0.25)
bun run bench:all                # everything
bun run bench:ci                 # json output for ci
```

74 deterministic cases: 39 classify + 10 ack + 5 time + 10 timezone + 10 schedule parsing.

15 LLM-judged cases: quality, personality, safety, tool use, edge cases.

## deploy

### docker

```bash
# with docker compose (recommended)
docker compose up -d

# or standalone
docker build -t koda .
docker run -d --env-file .env -p 3000:3000 koda
```

### vps

```bash
bun install --production
bun start
```

runs on anything that runs bun. 128mb ram is plenty. health checks at `/health`.

## tech stack

| layer | tech |
|-------|------|
| runtime | [bun](https://bun.sh) |
| language | typescript 5.9 (strict) |
| ai | [vercel ai sdk v6](https://sdk.vercel.ai) |
| llm routing | [openrouter](https://openrouter.ai) — 2-tier auto-routing |
| memory | [supermemory](https://supermemory.ai) (optional) + local sqlite vectors |
| search | [exa](https://exa.ai) |
| telegram | [grammy](https://grammy.dev) |
| database | sqlite via bun:sqlite (wal mode) |
| validation | [zod v4](https://zod.dev) |
| mcp | [@ai-sdk/mcp](https://sdk.vercel.ai/docs/ai-sdk-core/mcp) |
| cli ui | [@clack/prompts](https://github.com/bombshell-dev/clack) + chalk + ora |

## license

MIT
