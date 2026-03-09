# Koda Codebase Cleanup Report

**Date:** 2026-03-09  
**Branch:** `cursor/systematic-codebase-cleanup-dcbf`  
**Test result:** 199 pass / 0 fail  
**Type check:** Clean (`tsc --noEmit`)

---

## What Was Removed and Why

### 1. `@composio/vercel` dependency (`package.json`)

**Removed.** The package was listed as a runtime dependency but is never imported in any source file. A comment in `src/composio.ts` explains the reason: the Composio Vercel provider SDK has a bug where it sends both `text` and `arguments` in the execute payload, causing HTTP 400 errors. The codebase works around this by using `@composio/core` to discover tool schemas and then calling the Composio v3 REST API directly. The `@composio/vercel` package was vestigial from an earlier approach.

### 2. Duplicate imports in `src/agent.ts`

**Removed two redundant import statements.** The file had two separate `import` lines from `./db.js` (lines 16 and 25) and two separate `import` lines from `./time.js` (lines 17 and 26). These were consolidated into single imports per module. No behavior change.

**Before:**
```ts
import { messages as dbMessages, usage as dbUsage, toolOutcomes, summaries as dbSummaries } from "./db.js";
import { formatUserTime } from "./time.js";
// ... other imports ...
import { tasks as dbTasks } from "./db.js";
import { parseCronNext } from "./time.js";
```

**After:**
```ts
import { messages as dbMessages, usage as dbUsage, toolOutcomes, summaries as dbSummaries, tasks as dbTasks } from "./db.js";
import { formatUserTime, parseCronNext } from "./time.js";
```

### 3. Unused `reconnectMcpServer` import in `src/index.ts`

**Removed.** The function was imported from `./boot/mcp.js` but never called anywhere in `index.ts`. The export in `boot/mcp.ts` itself remains — it may be useful for programmatic use by future integrations — but importing it in the composition root where it had no call site was dead code.

### 4. Dead exports in `src/tools/subagent.ts`

**Removed `getRunningSessionKeys()` and `listNamedSessions()`.** Both were exported functions that were never imported anywhere else in the codebase. `getRunningSessionKeys()` returned `[...abortMap.keys()]` and `listNamedSessions()` returned running sub-agents from the DB. The dashboard and other consumers use `getSpawnLog()` (which queries the DB directly) instead.

### 5. `contextContent` field in `src/boot/providers.ts` `ProviderResult` interface

**Removed.** The `ProviderResult` interface included a `contextContent: string | null` field, but `src/index.ts` never destructures it — callers use the `getContextContent()` function instead (which is a closure over the same variable and handles hot-reload). The field was redundant; removing it prevents future confusion about which mechanism to use.

### 6. Trivial `textChunks` generator wrapper in `src/agent.ts`

**Removed.** The `createStreamAgent` function contained:

```ts
async function* textChunks() {
  for await (const chunk of streamResult.textStream) {
    yield chunk;
  }
}
return { fullStream: textChunks(), finishedPromise };
```

`streamResult.textStream` is already `AsyncIterable<string>`. The generator added no transformation — it was a pure passthrough. The return was simplified to:

```ts
return { fullStream: streamResult.textStream, finishedPromise };
```

`StreamAgentResult.fullStream` is typed as `AsyncIterable<string>`, so this is a direct, compatible assignment.

### 7. IIFE wrappers in `src/index.ts` seed task calls

**Simplified.** Four immediately-invoked function expressions wrapped single `seedRecurringTaskForTargets()` calls (or a single-condition guard + call). The IIFEs added no encapsulation benefit. They were replaced with direct calls and an `if`-block:

```ts
// Before
(function seedDailyBriefing() {
  if (!config.composio?.apiKey) return;
  seedRecurringTaskForTargets({ ... });
})();

// After
if (config.composio?.apiKey) {
  seedRecurringTaskForTargets({ ... });
}
```

---

## What Was Refactored and Why

### `@ts-ignore` → `@ts-expect-error` in `telegram.ts` and `slack.ts`

Both channel files use dynamic import of `pdf-parse`, which has no bundled type declarations. They previously suppressed the error with `// @ts-ignore`, which silently ignores any TypeScript error on the next line — including ones you didn't intend to suppress.

`// @ts-expect-error` is strictly better: it fails the type-check if the suppressed error disappears (e.g., if `pdf-parse` ships types in a future version), prompting cleanup. The comment is preserved as documentation.

---

## Architectural Concerns and Tech Debt (Not Touched)

### A. Direct `fetch()` calls to OpenRouter API in memory/summarize/consolidation code

`src/tools/memory.ts` (`extractMemoryFacts`, `extractProjectFacts`, `consolidateMemories`) and `src/summarize.ts` both call OpenRouter directly via `fetch()` rather than going through the Vercel AI SDK. This bypasses the SDK's retry, streaming, and model-fallback infrastructure. It was not changed because the behavior is intentional — these are lightweight, low-cost calls where the simplified fetch is sufficient — but it creates two maintenance paths for OpenRouter interaction.

**Suggestion:** Long-term, consider centralizing these calls through a shared `callLlm(model, messages, opts)` helper that uses either the SDK or a thin wrapper, so model swaps and retry logic only need updating in one place.

### B. Circuit-breaker state is module-level mutable globals

`src/agent.ts` (`llmFailures`, `lastLlmFailure`) and `src/tools/memory.ts` (`failures`, `lastFailureTime`) both use module-level mutable variables to implement circuit-breaker logic. This works correctly in single-process Bun, but makes the code harder to test in isolation (state leaks between tests) and would not work in a multi-process deployment.

**Suggestion:** If the project ever moves to clustered deployment or needs better unit-test isolation, encapsulate circuit-breaker state in a class or closure passed via dependency injection.

### C. `as unknown as ToolSet` cast in `composio.ts`

Line 158 contains `return tools as unknown as ToolSet`. This is a forced double-cast to work around the dynamic nature of Composio tool schema building. The tools built manually satisfy the shape of `ToolSet` at runtime but the TypeScript type system can't verify this statically due to the dynamic parameter schema construction. This is a known interop limitation documented in the comment at the top of the file.

**Suggestion:** If Composio eventually ships proper type declarations for their raw tool schema, remove the cast.

### D. `@ai-sdk/mcp` stdio transport cast in `boot/mcp.ts`

Line 16 uses `as unknown as McpTransport` to coerce the stdio config object. The `@ai-sdk/mcp` package's type for stdio transport doesn't perfectly match the shape being passed. This is a typing gap in the SDK.

**Suggestion:** File an issue upstream or add an overload once the types stabilize.

### E. Hardcoded pricing table in `src/router.ts`

The `PRICING` constant has three hardcoded model entries. Any model not in this table gets a cost of `$0` — meaning usage tracking underreports cost for new or custom models. Config supports a `pricing` override (`openrouter.pricing`) but it's not reflected in the default pricing table.

**Suggestion:** Make the pricing lookup check config-level overrides first, then fall back to the hardcoded table, so operators can add pricing for their model choices without patching source.

### F. `ingestConversation` rate-limiting via module-level `Map`

`src/tools/memory.ts` uses `ingestCallCounts: Map<string, number>` with a 500-entry cap to rate-limit memory extraction to every 3rd ingest call. This is in-memory only, so it resets on restart. After a restart, every session will extract on the first call rather than the 3rd, which is a minor over-extraction edge case.

**Suggestion:** Persist the call count in SQLite `state` table, or accept the current behavior as a reasonable approximation (the overhead is small and bounded).

---

## Summary of Changes

| File | Change |
|---|---|
| `package.json` | Removed unused `@composio/vercel` dependency |
| `src/agent.ts` | Merged duplicate `db.js` imports; merged duplicate `time.js` imports; removed trivial `textChunks` generator |
| `src/index.ts` | Removed unused `reconnectMcpServer` import; replaced 4 IIFEs with direct calls/if-blocks |
| `src/boot/providers.ts` | Removed `contextContent` from `ProviderResult` interface and return object |
| `src/tools/subagent.ts` | Removed dead exports `getRunningSessionKeys` and `listNamedSessions` |
| `src/channels/telegram.ts` | `@ts-ignore` → `@ts-expect-error` |
| `src/channels/slack.ts` | `@ts-ignore` → `@ts-expect-error` |
