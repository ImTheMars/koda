# Koda — Agent Instructions

## Cursor Cloud specific instructions

### Overview

Koda is a personal AI assistant built on **Bun** (not Node.js). It connects to Telegram or a local CLI REPL, routes messages through a 2-tier LLM system via OpenRouter, and uses SQLite (embedded) for persistence.

### Runtime

- **Bun** is the required runtime (>=1.0.0). It is installed at `~/.bun/bin/bun`. Ensure `~/.bun/bin` is on PATH.
- Do NOT use `node` or `npm` to run this project — always use `bun`.

### Key commands

See `package.json` `scripts` for the full list:
- `bun install` — install dependencies
- `KODA_MODE=cli-only bun run dev` — start in dev mode with file watching (CLI-only, no Telegram)
- `KODA_MODE=cli-only bun run cli` — start in CLI-only mode (no file watching)
- `bun start` — start in production mode (requires `KODA_TELEGRAM_TOKEN`)
- `bun test` — run tests (no test files exist yet)
- `bun run tsc --noEmit` — type-check (note: pre-existing error for missing `@types/pdf-parse`)

### Required secrets (env vars)

- `KODA_OPENROUTER_API_KEY` — required for all AI functionality (Zod validation fails without it)
- `KODA_TELEGRAM_TOKEN` — required unless running in `cli-only` mode

### Configuration

- Config file lives at `~/.koda/config.json` (auto-created by `bun run src/index.ts setup`)
- Template at `config/config.example.json`
- For CLI-only dev, set `"mode": "cli-only"` in config or `KODA_MODE=cli-only` env var
- The app auto-loads `.env` from `~/.koda/.env` and project root `.env`

### Gotchas

- The HTTP server binds to port 3000. If a previous instance didn't shut down cleanly, you may need to kill the process using that port before restarting.
- Docker sandbox is optional — the app gracefully falls back to native `Bun.spawn` if Docker is unavailable.
- The `bun run dev` command uses `--watch` for hot-reloading. However, dependency changes (`bun install`) require a full restart.
- SQLite DB is created at `~/.koda/koda.db` — no external database needed.
- No linter is configured in the project (no ESLint/Biome config). TypeScript type-checking via `bun run tsc --noEmit` is the primary static analysis.
