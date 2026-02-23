<h1 align="center">koda</h1>

<p align="center">
  <img src="https://img.shields.io/badge/v0.10.0-pre--release-10b981?style=flat-square" alt="v0.10.0" />
  <img src="https://img.shields.io/badge/bun-runtime-f472b6?style=flat-square" alt="Bun" />
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="MIT" />
</p>

<p align="center">
  a personal ai that actually feels personal.<br/>
  <sub>remembers everything. browses the web. schedules tasks. delegates to sub-agents. reads documents. generates images. texts like a real one.</sub>
</p>

---

a long-running ai assistant that connects to telegram or a local cli, routes every message through the right model for the job, remembers your preferences via semantic memory, creates its own skills, schedules reminders, browses the web, spawns sub-agents for parallel work, reads PDFs and documents, generates images, and replies like a real person.

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
   |  image - sendFile           |
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

tool cost tracking: external API costs (Exa search, image generation) are tracked separately from LLM token costs via `addToolCost()`, accumulated per-request via AsyncLocalStorage, and stored in the `usage` table.

sub-agent streaming: spawned child agents broadcast live progress via `streamUpdate` and return structured results via `returnResult`. the dashboard displays progress lines in real time over SSE.

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

## telegram commands

| command | what it does |
|---------|-------------|
| `/help` | list all commands |
| `/clear` | reset conversation history |
| `/usage` | see token usage and costs |
| `/status` | system health summary — uptime, memory, models, costs, next task |
| `/deep` | force next message to use deep tier |
| `/fast` | force next message to use fast tier |
| `/recap` | summarize recent conversation — key topics, decisions, open items |
| `/model` | view or change models (`/model fast google/gemini-3-flash-preview`) |

## features

- **document ingestion** — send PDFs, text files (.txt, .md, .csv, .json, .html, .xml) directly in Telegram. koda extracts the text and responds in context.
- **reply threading** — reply to any message and koda sees the original text as context.
- **forwarded messages** — forward messages to koda and it knows who/where they came from.
- **edited messages** — edit a sent message and koda processes the update.
- **image generation** — `generateImage` tool creates images via OpenRouter (default: google/gemini-3-pro-image-preview).
- **file sending** — `sendFile` tool sends workspace files back as Telegram documents.
- **tier override** — `/deep` and `/fast` commands force the next message to a specific model tier.
- **model switching** — `/model` command lets you change fast/deep/image models on the fly, persisted to config.
- **database backup** — automatic daily SQLite backup to `~/.koda/backups/` with 7-day retention.
- **webhook mode** — optional Telegram webhook support instead of polling.
- **startup/shutdown notifications** — admin users get notified when koda comes online or goes down.
- **dashboard** — real-time web UI at `/` with usage stats, skills, tasks, sub-agent activity. SSE-powered live updates.
- **tool cost tracking** — external API costs (Exa, image generation) tracked separately from LLM costs.
- **MCP** — connect external tool servers (Notion, GitHub, etc.) via `@ai-sdk/mcp`. stdio, SSE, and HTTP transports. auto-reconnect on crash.
- **sub-agents** — spawn focused child agents for parallel work. isolated sessions, filtered tools, config-driven limits. live progress via `streamUpdate`. structured results via `returnResult`. addressable via `@AgentName: ...`.
- **skill shop** — search and install community skills from GitHub. safety scoring before install.
- **docker sandbox** — run untrusted code in isolated containers with hard resource limits.
- **local embeddings** — optional vector memory via Ollama for fully offline operation.
- **Ollama** — use local LLMs for fast tier when configured. falls back to OpenRouter when unavailable.
- **soul personality** — editable `soul.md` + `soul.d/*.md` with filesystem watcher for hot-reload.
- **memory provider selection** — automatic: local embeddings (Ollama) > Supermemory cloud > SQLite keyword fallback.

## config reference

all fields are optional except `openrouter.apiKey` (via env var).

| section | field | default | description |
|---------|-------|---------|-------------|
| `mode` | | `"private"` | `"private"` (telegram) or `"cli-only"` |
| `owner` | `id` | `"owner"` | owner user ID |
| `openrouter` | `fastModel` | `google/gemini-3-flash-preview` | fast tier model |
| `openrouter` | `deepModel` | `anthropic/claude-sonnet-4.6` | deep tier model |
| `openrouter` | `imageModel` | `google/gemini-3-pro-image-preview` | image generation model |
| `agent` | `maxSteps` | `30` | max tool loop steps |
| `agent` | `maxTokens` | `8192` | max output tokens per turn |
| `agent` | `temperature` | `0.7` | LLM temperature |
| `timeouts` | `llm` | `120000` | LLM request timeout (ms) |
| `timeouts` | `memory` | `10000` | memory/embedding timeout (ms) |
| `timeouts` | `search` | `30000` | search/external API timeout (ms) |
| `scheduler` | `timezone` | `America/Los_Angeles` | IANA timezone for scheduling |
| `proactive` | `tickIntervalMs` | `30000` | scheduler tick interval |
| `features` | `scheduler` | `true` | enable/disable proactive scheduler |
| `features` | `debug` | `false` | enable debug logging |
| `features` | `autoBackup` | `true` | daily SQLite backup |
| `subagent` | `timeoutMs` | `90000` | sub-agent timeout |
| `subagent` | `maxSteps` | `10` | sub-agent max steps |
| `ollama` | `enabled` | `false` | use local Ollama for fast tier |
| `ollama` | `baseUrl` | `http://localhost:11434` | Ollama server URL |
| `ollama` | `model` | `llama3.2` | Ollama model name |
| `embeddings` | `enabled` | `false` | local vector memory via Ollama |
| `mcp` | `servers` | `[]` | MCP server configurations (stdio, sse, http) |
| `telegram` | `useWebhook` | `false` | use webhook instead of polling |
| `telegram` | `webhookUrl` | — | webhook URL (e.g., `https://koda.example.com/telegram`) |
| `telegram` | `webhookSecret` | — | secret token for webhook verification |

## tools

| tool | what it does |
|------|-------------|
| **remember** / **recall** | semantic memory — stores facts, retrieves relevant context. supermemory cloud or local sqlite vector (ollama embeddings) or sqlite keyword fallback. |
| **webSearch** / **extractUrl** | exa-powered web search + page content extraction. cost tracked per call. |
| **readFile** / **writeFile** / **listFiles** | workspace-scoped filesystem. blocked patterns for .env, secrets, node_modules. |
| **runSandboxed** | isolated Docker container execution with resource limits (512MB RAM, 0.5 CPU, no network). |
| **createReminder** / **createRecurringTask** / **listTasks** / **deleteTask** | timezone-aware scheduling with natural language ("every Monday at 9am") and cron format. |
| **skills** | list, load, or create SKILL.md files. koda teaches itself new abilities at runtime. |
| **skillShop** | search and install community skills from GitHub via Exa. |
| **getSoul** / **updateSoul** | read or rewrite personality sections. hot-reloaded without restart. |
| **systemStatus** | uptime, memory usage, circuit breaker state, today's cost, next scheduled task. |
| **spawnAgent** | delegate sub-tasks to isolated child agents with filtered toolsets. multiple spawns run concurrently. returns structured results. |
| **generateImage** | generate images via OpenRouter image models. |
| **sendFile** | send workspace files back to the user as document attachments. |

## database

6 tables in SQLite (WAL mode):

| table | purpose |
|-------|---------|
| `messages` | conversation history per session |
| `tasks` | reminders + recurring scheduled tasks |
| `usage` | per-request cost, tool cost, and token tracking |
| `state` | key-value store (schema version, seeds) |
| `subagents` | sub-agent spawn records |
| `vector_memories` | local embedding vectors |

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
