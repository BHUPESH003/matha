# matha vs. supermemory — Comparative Study

**Date:** 2026-07-11
**Reference:** [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory), shallow clone of `main`, read-only. No code was copied.
**Caveat on evidence:** supermemory's public repo contains the *clients* — the hosted MCP server (`apps/mcp/`), framework wrappers (`packages/tools/`), browser extension, and full docs. The core engine (extraction, ranking, storage) is closed-source; where a claim below rests on docs rather than code, it says so. Their data model leaks cleanly through client types (`packages/memory-graph/src/api-types.ts`, `apps/mcp/src/client.ts`).

The comparison is deliberately asymmetric: supermemory is a funded, general-purpose, cloud memory platform; matha is a local, dev-workflow-only tool. The point is not to clone them — it is to see which of their hard-won mechanisms matter at matha's scale, and where matha's narrowness lets it skip whole subsystems.

---

## Axis 1 — Capture

**What supermemory does.** Five write triggers, most of them automatic: (1) agentic tool calls — MCP `memory` tool with `action: save|forget`, with tool descriptions that instruct the model *when* to save; (2) automatic conversation ingestion — Vercel AI SDK middleware posts the whole conversation after each response (`POST /v4/conversations`), backend does diff/append detection; (3) a transparent LLM proxy ("Memory Router") that extracts memories asynchronously after each response; (4) connectors (Drive, Gmail, Notion, GitHub) via webhooks/cron; (5) browser extension capture. Raw input is a *document*; an LLM extraction pipeline turns documents into discrete *memories*. Ingestion has quality knobs: org-wide LLM filtering with a custom `filterPrompt`, `customId` for idempotent upserts, content hashing for dedup.

**What matha does today.** 100% manual, human-keyboard-first: interactive CLI prompts in `before`/`after`, plus three voluntary MCP write tools (`matha_record_decision/danger/contract`). No extraction step — whatever string the human or agent typed *is* the memory. No validation (a recorded decision in matha's own dogfood brain is literally `assumption: "y" → correction: "y"`), no dedup, no upsert, no filtering.

**What matha SHOULD do.** matha's narrow scope is a genuine advantage here: its "documents" already exist in structured form — git history, diffs, the agent's own session. It does not need connectors, a proxy, or an extraction LLM:

1. **The agent is the extractor.** In an MCP-native workflow, the coding agent already knows what assumption broke — capture should be agent-driven tool calls at session end, not human interview prompts. The interactive `after` interview should become a fallback, not the primary path.
2. **Schema-validated writes.** Because matha stores exactly four opinionated record types (decision, rule, danger zone, contract) instead of freeform "memories", it can *reject garbage at the door*: minimum lengths, required path scoping, no empty components, near-duplicate detection (lexical similarity against existing records — supermemory's content-hash dedup, downscaled). This is cheaper than supermemory's LLM filter and fits the domain better.
3. **Automatic capture from git stays and grows.** The cortex (churn/stability/co-change) is matha's only truly automatic capture today and it's the differentiator supermemory doesn't have — keep it, and refresh it automatically on read-staleness instead of only at `init`.
4. **Adopt the "tool description teaches the model when to write" trick** from their MCP server — matha's write-tool descriptions should state concrete dev-workflow triggers ("call when a stated assumption about this codebase proved wrong", "call when you discover a change here breaks something non-obvious elsewhere").

---

## Axis 2 — Storage

**What supermemory does.** Two-level model: documents (raw) → memories (extracted facts). Memories form a versioned fact graph: `version`, `parentMemoryId`, `rootMemoryId`, `nextVersionId`, `isLatest`, with three edge types — `updates` (contradiction; supersedes), `extends` (enrichment; both stay valid), `derives` (inference). Soft-forgetting: `isForgotten`, `forgetAfter` (timed expiry), `forgetReason`. Scoping via `containerTag`. Hosted engine: Cloudflare Workers + Postgres + vector embeddings + KV, async ingestion pipeline (Queued → Extracting → Chunking → Embedding → Indexing). Self-hosted variant embeds a graph engine in a `.supermemory/` dir with local 768-d embeddings. Chunk size configurable (256–2048).

**What matha does today.** Plain JSON files under `.matha/` in the repo. No index — every read rescans files. The `DecisionEntry` schema *has* `status: active|superseded|invalidated`, `supersedes`, and `confidence` fields, but nothing can ever set them after creation: no update path, no review surface, no expiry. Contracts are overwrite-in-place with a `version` field that is always `1`. Danger zones can never be retired at all.

**What matha SHOULD do.** Keep JSON-in-repo — do not copy the engine. This is the deliberate, defensible difference: a dev project's brain is hundreds of records, not millions; it should be diffable in PRs, reviewed like code, and versioned by git itself. No database, no vector store, no async pipeline. What *is* worth adopting is their **lifecycle contract**, which matha's schema already half-declares:

1. Make `supersedes`/`status` real: a new decision on the same subject links and supersedes the old one (their `updates` edge); retrieval returns only `active` records but history stays.
2. Add soft-retirement with reason (their `isForgotten`/`forgetReason`) for danger zones and rules — bad captures must be curable without hand-editing JSON.
3. Adopt the **confidence/review split**: their inferred memories are down-weighted until human-approved; matha's `probable` (agent-written) vs `confirmed` (human-verified) is the same idea and should gate ranking weight the same way (see Retrieval).
4. One schema module with one sanitizer — today two different filename sanitizers mean contract violations never find their contract (current-state §2.4).
5. Skip: chunking (records are already atomic facts), embeddings-at-rest, containerTag multi-tenancy (the repo *is* the container).

---

## Axis 3 — Retrieval

**What supermemory does.** Vector search over embedded memories with a hybrid mode (memories first, fall back to document chunks, merge + dedup). Tunables: similarity `threshold` (default 0.5), optional secondary **reranker** (+100–200ms), optional **query rewriting** (LLM generates variants, parallel search, merge; +~400ms), metadata filters. Graph-aware: related memories can be included; inferred memories are down-ranked until approved. The headline pattern is **profile-first retrieval**: one `/v4/profile` call returns `static` (stable facts) + `dynamic` (recent context) + optional query-matched results — pitched as replacing 3–5 searches at ~50ms. Token cost is managed everywhere in the open client code: modes (`profile|query|full`), client-side dedup with priority static > dynamic > search, per-turn retrieval cache, retrieval timeout, hard char caps on MCP output (200k content, 500-char list entries, max 3 documents / 4 relations in recall), and a benchmark metric (MemScore) that counts context tokens as a first-class cost.

**What matha does today.** Case-insensitive substring containment between the caller's scope/intent strings and stored component strings, plus a >4-char keyword filter for danger zones. No scoring, no threshold (empty component matches *everything* as CRITICAL), no ranking beyond a 3-level severity sort, no confidence weighting, no recency, no dedup beyond exact type+component, no token cap on any response, no cache. It both over-fires and under-fires, which the field evaluation demonstrated on a real project (9/100).

**What matha SHOULD do.** This is where being narrow is the biggest advantage. Supermemory needs embeddings because its queries are arbitrary natural language against arbitrary content. matha's queries are not arbitrary — they are `(filepaths, intent, operation type)` against records that are (or should be) path-scoped. Structure beats semantics here:

1. **Structural matching first.** Normalize every record to carry `paths: string[]`. Match by exact file, ancestor directory, and glob. A zone on `src/payments/` must match scope `src/payments/retry.ts` — hierarchy, not substring.
2. **Co-change expansion second.** matha already has the co-change graph supermemory lacks: if the query touches `a.ts`, records scoped to files that historically co-change with `a.ts` are pulled in at reduced score. This is matha's equivalent of their `relatedMemories` graph hop — derived from git for free.
3. **Lexical scoring third.** BM25-style scoring of intent text against record text (a few dozen lines over a few hundred records — no library, no embeddings). Embeddings are a *deferred* option, added only if the eval harness (Axis 5) proves lexical recall insufficient.
4. **Rank = structural score × lexical score × confidence weight × recency decay**, with a minimum threshold (kills the empty-component-matches-everything class of bug structurally). `confirmed` outranks `probable` outranks `uncertain` — their inference-down-weighting pattern.
5. **Adopt profile-first brief assembly wholesale.** `matha_brief` becomes exactly their profile call: *static* (intent + rules — small, always included) + *dynamic* (recent active decisions in scope) + *query-matched* (ranked matches), deduped with priority static > dynamic > matched, assembled under a **hard token budget** (default on the order of ~1.5k tokens, configurable), highest-rank-first until the budget is spent, with a `truncated: true` flag when it overflows. Every retrieval response also carries diagnostics (which brain dir, how many records considered) so a wrong-brain failure is visible instead of silent.

---

## Axis 4 — Integration surface

**What supermemory does.** Six surfaces: REST + generated SDKs; a hosted MCP server (OAuth, 5 tools: `memory`, `recall`, `listMemories`, `listProjects`, `whoAmI`, plus MCP resources and a `context` prompt that injects the profile and a standing instruction to keep saving); framework middleware (Vercel AI SDK / Mastra / OpenAI / VoltAgent) that injects memories into the system prompt invisibly; an adapter mapping Anthropic's file-based memory-tool commands onto their API; an LLM proxy requiring only a base-URL swap; a semantic filesystem (SMFS). The consistent theme: **integration cost approaches zero** — the consumer changes one line or nothing.

**What matha does today.** Two surfaces: an interactive CLI whose output the human copy-pastes into the agent, and a local stdio MCP server whose project-root resolution is broken (current-state §2.1) — the one wiring step that had to work. `init` writes an MCP config with absolute paths that go stale and a launch command that fails on Windows.

**What matha SHOULD do.**

1. **MCP is the product surface; the CLI is administration.** Kill copy-paste-the-brief as the primary workflow; keep the CLI for `init`, review/curation, refresh, and diagnostics.
2. **Fix root resolution with the MCP-native answer:** the MCP spec's `roots` capability lets the client tell the server the workspace folders — use it, then explicit `--project`, then walking up from the tool-call's `filepaths`, then cwd. **Never silently create an empty brain** — an unresolved root must return an error payload naming the paths it tried (their diagnostic-headers instinct, applied locally).
3. **Adopt their MCP-server craft** directly visible in `apps/mcp`: an MCP *prompt* that injects the brief plus a standing "record what you learn" instruction (their `context` prompt), hard output caps per tool, and few, well-described tools rather than many. matha's nine tools should consolidate around `matha_brief` (profile-style) + `matha_match` (pre-change check) + one consolidated write tool.
4. **One-command wiring per IDE:** `matha init` should write the actual config files agents read (`.mcp.json` for Claude Code, `.cursor/mcp.json`, etc.) with relative/portable commands — their one-line-integration standard, applied to the local case. Agent-hook integration (e.g. Claude Code SessionStart/Stop hooks calling `matha`) is the local analogue of their middleware auto-capture.

---

## Axis 5 — Evaluation

**What supermemory does.** A separate provider-pluggable benchmark harness (MemoryBench: supermemory/mem0/zep × LongMemEval/LoCoMo/ConvoMem, LLM judge) and a deliberate three-part metric, **MemScore = accuracy% / latency ms / context tokens** — retrieved-context token cost is measured client-side with real tokenizers and treated as a first-class cost, not an afterthought. They publish scores (81.6% LongMemEval) as the product's headline. In-repo testing is client-level (MCP e2e tests).

**What matha does today.** The dopamine subsystem was *meant* to be a self-evaluation loop (predicted vs. actual tokens per session) but never closes (current-state §2.2) — and even if fixed, it measures the wrong thing: it evaluates *cost prediction of the human's session*, not *retrieval quality of the context served*. The only real evaluation ever done is one manual field report (`docs/matha_evaluation_report.md`, 9/100), which was excellent and should be an automated regression, not a one-off document.

**What matha SHOULD do.** Steal the metric shape, not the harness:

1. **Golden-set retrieval eval, in CI.** Fixture brains + a query set of `(filepaths, intent) → expected record ids`. Report recall@k, precision@k, tokens-per-brief, latency — MemScore's triple, downscaled. This is the *only* honest way to answer "did the agent get better/cheaper context", and it also gates the embeddings decision (Axis 3.3) with data instead of taste.
2. **Codify the field eval** as an end-to-end test: script the six steps of the Mettle evaluation against a fixture project through a real spawned MCP server process, assert a minimum score.
3. **Retire the dopamine/tier-routing loop** as an evaluation mechanism. If cost telemetry is wanted later, measure the one thing matha controls — brief token size vs. task outcome — not model-tier guessing.

---

## Summary table

| Axis | supermemory | matha today | matha target (opinionated, dev-only) |
|---|---|---|---|
| Capture | Automatic (middleware/proxy/connectors) + agentic; LLM extraction; dedup/filter at ingest | Manual prompts + voluntary MCP calls; no validation; garbage gets in | Agent-driven MCP writes with schema validation + dedup; git-derived capture (cortex) auto-refreshed; interview as fallback |
| Storage | Versioned fact graph (updates/extends/derives), soft-forget + expiry, Postgres+vectors, cloud | JSON in repo; lifecycle fields exist but unusable; no curation path | Keep JSON-in-repo (diffable, git-versioned); make supersede/retire/confirm real; one schema module; no DB, no vectors |
| Retrieval | Embeddings, hybrid search, rerank, query rewrite, profile-first, aggressive token caps | Substring containment; no ranking/threshold/budget; over- and under-fires | Structural path match + co-change expansion + BM25 lexical; confidence-weighted ranking; profile-style brief under hard token budget; embeddings only if eval demands |
| Integration | 6 near-zero-cost surfaces; MCP with prompts/resources/caps | Copy-paste CLI + MCP server that resolves the wrong root | MCP-first (roots capability, loud failures, brief-injecting prompt); CLI for admin; one-command IDE wiring + agent hooks |
| Evaluation | MemoryBench + MemScore (accuracy/latency/context-tokens), published | Broken self-loop measuring the wrong thing; one manual report | Golden-set retrieval eval in CI (recall/precision/tokens/latency); field eval codified e2e; drop tier-routing |
