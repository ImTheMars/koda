# roadmap

what's coming next for koda. ordered roughly by priority.

**cost target**: current estimated cost is ~$3-5/month LLM + $0.50/month voice for personal use. goal is to keep total under $10/month through v2. every routing and model decision should be measured against this.

**what's already shipped in v1.0**: 3-tier routing with model escalation, model failover chains (openrouter `models` array), semantic memory with circuit breaker, local code execution, stagehand browser (5 actions), workspace-scoped filesystem, skill self-creation at runtime, voice STT/TTS pipeline, proactive scheduling, soul personality with hot-reload, interactive CLI (setup/doctor/upgrade), dockerfile, railway.toml, install scripts (sh + ps1), 55-case deterministic benchmark suite at 100% pass.

---

## v1.1 — hardening

things that should have shipped in v1 but didn't make the cut. all small, all high-impact.

- [x] **telegram voice reply** — voice messages now get voice-only replies (cartesia sonic 3 TTS). text fallback when TTS unavailable.
- [x] **docker-compose** — added. mount workspace volume + config as read-only. production-ready with health checks and restart policy.
- [x] **context compaction** — when tool step count exceeds 10, older messages are spliced to keep the last 6. prevents context window exhaustion on deep tool chains.
- [x] **usage dashboard** — `/usage` command in telegram shows today/month/all-time request counts and costs.
- [x] **heartbeat file** — heartbeat now parses `- [ ]` / `- [x]` checkboxes, sends only pending items with structured count to agent.
- [x] **skill hot-reload** — no-op: skills already reload on-demand. `loadSkill()` reads fresh every call, no cache to invalidate.
- [x] **message dedup by hash** — switched from message_id to content hash via `Bun.hash()`. identical content with different IDs now correctly deduped.
- [x] **graceful telegram reconnect** — exponential backoff retry loop with jitter. consecutive error tracking auto-restarts bot after 5 failures.
- [x] **voice pipeline upgrade** — STT moved from groq whisper to gemini 3 flash via openrouter (reuses existing API key). TTS moved from openai tts-1 to cartesia sonic 3 (lower latency, better quality).

## v1.2 — learning + adaptive routing

bring back the learning features from v0 but simpler. plus: make the router learn from actual usage.

- [ ] **outcome detection** — detect when a user says "that worked" / "that's wrong" / "close but not quite" and store the outcome in the learnings table. feed recent learnings back into the system prompt.
- [ ] **preference extraction** — when the user corrects koda ("no, i meant X not Y"), extract the preference and store it. use it to avoid repeating the same mistake.
- [ ] **correction loop** — if koda gets something wrong and the user corrects it, automatically create a learning entry and acknowledge the correction naturally.
- [ ] **learning decay** — old learnings should gradually lose weight. a correction from 6 months ago matters less than one from yesterday.
- [ ] **adaptive routing** — replace keyword rules with a small semantic classifier. ~50 labeled examples per tier gets 85-95% accuracy. the usage table already has every message with its tier and intent — train on that. can start with a simple embedding similarity approach before going to a fine-tuned model.
- [ ] **sqlite-vec for memory fallback** — replace the keyword-search sqlite fallback with vector search via sqlite-vec. this sets up the foundation for RAG in v2.1 — same table, same embeddings, just add workspace files later.

## v1.3 — MCP + safety

MCP client support is koda's biggest extensibility lever. `@ai-sdk/mcp` lets you connect notion, github, home assistant, linear, etc. with zero code changes — just add a server config. this replaces the need for a custom plugin system entirely.

- [ ] **MCP client** — add `@ai-sdk/mcp` integration. define MCP servers in config.json, auto-discover tools at boot, merge into the agent's tool set. one config entry = one integration. this is cheaper, more standard, and more powerful than building `koda install @koda/plugin-github` from scratch.
- [ ] **MCP server config UI** — `koda setup` wizard step to add/remove MCP servers. list available servers, test connections.
- [ ] **prompt injection detection** — bring back the injection detector from v0. keyword matching + structural analysis. log detections, don't hard-block (koda should handle it gracefully in conversation).
- [ ] **rate limiting per user** — per-user rate limits for telegram (currently global). prevent abuse in group scenarios.
- [ ] **content filtering** — basic output filtering for PII leakage. koda shouldn't accidentally echo back someone's API key.

## v2.0 — multi-user

the big one. koda currently assumes a single owner. v2 makes it work for small groups.

- [ ] **user profiles** — per-user memory, preferences, and learnings. koda remembers different things for different people.
- [ ] **permission model** — owner, admin, user, guest tiers. different tool access per tier (guests can chat but can't run code or browse).
- [ ] **group chat** — koda in telegram groups. mention-based activation (@koda), thread awareness, context per conversation thread.
- [ ] **multi-channel** — discord channel alongside telegram. abstract the channel interface so new platforms are plug-and-play.
- [ ] **shared workspace** — multiple users can share a workspace with shared files, tasks, and skills. per-user sandboxing for exec.

## v2.1 — intelligence

- [ ] **RAG over workspace** — embed workspace files into the same sqlite-vec table from v1.2. when someone asks "what did we decide about the database?", koda searches its own files. two birds, one stone — memory fallback and workspace search use the same vector index.
- [ ] **conversation summarization** — periodically summarize long conversations into learnings. auto-compress context for the next session.
- [ ] **task decomposition** — when given a complex task, break it into subtasks, execute them in sequence, and report progress. like a mini project manager.

## v2.2 — platform

- [ ] **web ui** — simple web interface as an alternative to telegram/cli. websocket-based real-time chat.
- [ ] **api** — REST/websocket API so other apps can talk to koda. authentication via API keys.
- [ ] **mobile app** — lightweight mobile client that talks to the koda API. push notifications for reminders.

## someday / maybe

things that would be cool but aren't prioritized.

- [ ] **npm plugin system** — `koda install @koda/plugin-X` for tool plugins. likely unnecessary if MCP covers the integration surface well enough. evaluate after v1.3 MCP ships.
- [ ] **multi-agent** — spawn sub-agents for parallel tool use. one agent browses while another searches.
- [ ] **image generation** — integrate with dall-e or flux for image creation tools.
- [ ] **screen sharing** — connect to a user's screen for live assistance (via browser tool + streaming).
- [ ] **fine-tuned router** — train a tiny model on koda's own routing decisions. would need ~10k labeled examples from production usage. the adaptive routing in v1.2 may be good enough.
- [ ] **federated memory** — share memory across multiple koda instances. a koda network.
- [ ] **offline mode** — local llm fallback (ollama/llama.cpp) when internet is unavailable. fast tier only.

---

*this roadmap is aspirational, not a commitment. priorities shift based on what's actually useful in daily use.*
