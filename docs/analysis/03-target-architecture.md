# matha — Target Architecture & Roadmap to v1.0

**Date:** 2026-07-11
**Inputs:** `01-current-state.md` (what's broken), `02-supermemory-comparison.md` (what a mature system does and what matha should deliberately not do).
**Status:** product-boundary cut (§0) **approved 2026-07-11** — matha v1.0 is capture → store → retrieve → eval, not an enforcer. §5 records the design answers from that review. Implementation awaits phase-level go-ahead.

---

## 0. The product boundary this architecture assumes

The 0.1.x prototype tries to be two products:

- **A — a project-memory server**: capture intent/decisions/danger zones/contracts, retrieve the right subset for the agent's current operation, cheaply.
- **B — a process enforcer**: interactive gates 01–08, model-tier routing, token-budget prediction, contract pass/fail interviews (the dopamine + frontal-lobe + interactive-gates half).

Product B is the half that is broken end-to-end (dopamine loop never closes, gates are dead code, tier tables disagree), measures things matha doesn't control (which model the IDE uses), and imposes the most human ceremony. Product A is the half with real stored value that failed only at the wiring layer — and it is the half the market (supermemory, mem0, zep) validates.

**This architecture builds product A. Product B is cut from v1.0** (the concepts survive where they're cheap: contracts remain a *record type* that retrieval surfaces; pass/fail interviews, tier routing, and gate ceremony go). Approved 2026-07-11 — see the decision log in §6.

---

## 1. Module architecture

```
src/
  core/
    schema.ts       # ALL record types + validation + the ONE sanitizer/id scheme
    resolve.ts      # brain-dir resolution (the #1 bug, fixed in exactly one place)
    engine.ts       # composition root: wires store+retrieve; the only API
                    # surfaces are allowed to call
  store/
    fs.ts           # atomic JSON read/write (today's storage/, kept nearly as-is)
    records.ts      # typed CRUD per record type; lifecycle transitions
                    # (supersede / retire / confirm); dedup-on-write
    migrate.ts      # real migrations, one per schema bump
  codemap/          # was "cortex" — git-derived knowledge
    git-analyser.ts        # kept
    stability.ts           # kept (classifier)
    refresh.ts             # staleness-aware refresh (auto on read if stale)
  retrieve/
    match.ts        # structural + co-change + lexical scoring (see §2)
    brief.ts        # token-budgeted brief assembly (profile-style)
  mcp/
    server.ts       # thin adapter: schemas + dispatch → engine; MCP roots;
                    # prompt that injects brief + "record what you learn"
  cli/
    init.ts         # setup + IDE config writing (.mcp.json etc.)
    review.ts       # curation: list/confirm/retire/supersede records
    doctor.ts       # diagnostics: which brain, counts, staleness, config health
    serve.ts        # starts mcp server with explicit root
  eval/
    harness.ts      # golden-set runner (see §3)
    fixtures/       # fixture brains + query sets
```

Rules that prevent the 0.1.x failure modes from recurring:

1. **One composition root.** `engine.ts` is the only module CLI and MCP may import. Every 0.1.x divergence bug (three tier tables, two sanitizers, two stability lookups, two brief builders) was two surfaces re-assembling the same pipeline; make that structurally impossible.
2. **One schema module.** Every record type, id scheme, filename sanitizer, and validation rule lives in `core/schema.ts`. Writes that fail validation are rejected with a reason the agent can read (no more `"y" → "y"` decisions).
3. **Fail loud, degrade honestly.** The never-throw policy survives only at the MCP boundary, and every response carries `diagnostics: { brainDir, recordsConsidered, staleness }`. An unresolved brain returns an error naming the paths tried — never a silently created empty brain.
4. **Brain-dir resolution order** (`core/resolve.ts`): explicit `--project` flag (actually plumbed through) → MCP `roots` capability from the client → walk up from the first `filepaths` argument of the tool call → walk up from cwd → error.
5. **Storage stays JSON-in-repo.** Diffable, PR-reviewable, git-versioned, zero deps. At dev-project scale (10²–10³ records) full scans are microseconds; no index, no DB, no embeddings store. Record files keep today's layout where possible; `migrate.ts` handles the deltas (and actually runs, unlike the 0.1.x stub).
6. **Deleted outright:** `frontal-lobe.ts` (dead parallel implementation), dopamine prediction/actuals/deltas/routing, gate ceremony in `before`, the dead `directory` mode in brief, duplicate tool definitions, open-questions storage (no surface uses it; reintroduce if a surface ever needs it). Naming drops the brain metaphor in code (`hippocampus` → `store/records`, `cortex` → `codemap`); the brand can keep the metaphor, the modules can't afford it.

### Record model (v1)

Four types, one shared envelope:

```jsonc
{
  "id": "…", "type": "decision|rule|danger|contract",
  "paths": ["src/payments/"],          // REQUIRED scoping (dir, file, or glob)
  "text":  "…",                        // the fact/rule/pattern/assertion(s)
  "confidence": "confirmed|probable|uncertain",   // human vs agent vs guess
  "status": "active|superseded|retired",
  "supersedes": null, "retiredReason": null,
  "createdAt": "…", "source": "mcp|cli|import"
}
```

Type-specific extras ride on top (contracts keep `assertions[]` with violation counts; decisions keep `previous_assumption`/`correction`). Lifecycle transitions (`supersede`, `retire`, `confirm`) are engine operations available to both `matha review` (human) and a consolidated MCP write tool (agent) — supermemory's updates/forget/review contract, downscaled to the four fields it actually takes.

---

## 2. Retrieval strategy (the core)

Query = `(filepaths[], intent, operationType)` — never arbitrary NL. That structure is why matha can skip embeddings in v1.

### Scoring pipeline (`retrieve/match.ts`)

For each active record, score = **S × L × C × R**, keep records above a minimum threshold, rank descending:

1. **S — structural path score.** Normalize record `paths` and query `filepaths`. Exact file match 1.0; record path is an ancestor dir of a query file (or glob match) 0.8; sibling-in-same-dir 0.4; no path overlap → S from co-change expansion: if a record's path co-changes with a query file (codemap graph, weighted by co-change count) S up to 0.5. No overlap at all → S = 0.1 (text-only records can still surface on strong lexical match, but never as CRITICAL).
2. **L — lexical score.** BM25 over tokenized record text vs. intent (lowercase, split, stop-words, naive stemming). ~40 lines, no dependency. Records with empty/blank text or paths are rejected at *write* time, so the empty-matches-everything bug class is dead by schema, not by patch.
3. **C — confidence weight.** `confirmed` 1.0, `probable` 0.7, `uncertain` 0.4. Agent-recorded knowledge is useful immediately but outranked by human-verified knowledge until confirmed via `matha review` — supermemory's inference-review pattern.
4. **R — recency.** Gentle decay on decisions (half-weight ≈ 180 days); rules and contracts don't decay.

Severity is then a *presentation* attribute: a matched danger zone or frozen-file hit with S ≥ 0.8 is CRITICAL; matched contracts INFO; matched decisions WARNING — same taxonomy as today, but gated by score instead of substring luck.

### Brief assembly (`retrieve/brief.ts`) — profile-first, token-budgeted

`matha_brief` returns three sections under one hard budget (default ~1,500 tokens, ~4 chars/token estimate, configurable):

- **static** — intent (why) + active rules matching the scope (rules with no path scope are project-global and always included). Small and stable; the "profile.static".
- **dynamic** — the N most recent active decisions in scope. The "profile.dynamic".
- **matched** — ranked results from the scoring pipeline, deduped against static/dynamic (priority static > dynamic > matched), added highest-score-first until the budget is exhausted; response sets `truncated: true` and the count omitted when it overflows.

`matha_match` is the same pipeline without the static/dynamic sections — the cheap pre-change check. Both responses always include `diagnostics`. Result: token cost is bounded and *known*, and "agent got better/cheaper context" becomes measurable (§3).

### Embeddings: explicitly deferred, with a tripwire

If the golden-set eval shows lexical recall@5 below target (§3) on realistic fixtures — specifically on concept-worded records vs. path-worded queries — the upgrade path is a local embedding model over record text only (hundreds of vectors, brute-force cosine, still no DB). That decision is made by eval numbers, not taste.

---

## 3. Evaluation plan — proving "better/cheaper context"

Three layers, cheapest first:

1. **Golden-set retrieval eval (CI, every commit).** `eval/fixtures/` holds 2–3 fixture brains (one synthetic, one adapted from matha's own dogfood data, one modeled on the Mettle field eval) with 30–50 queries each: `(filepaths, intent) → expected record ids (+ ids that must NOT surface)`. Metrics per run: **recall@5, precision@5, false-critical rate, tokens-per-brief, p95 latency** — the MemScore triple plus the over-firing measure that burned 0.1.x. CI fails on regression below thresholds (initial targets: recall@5 ≥ 0.8, false-critical ≤ 0.05, brief ≤ budget always).
2. **End-to-end wiring test (CI).** Scripted: `init` a fixture project → record via MCP → kill server → new server process from a *different cwd* → `brief`/`match` round-trip returns the recorded knowledge. This single test would have caught the wrong-brain bug, the unregistered tools, and both sanitizer mismatches. The six-step field evaluation from `docs/matha_evaluation_report.md` gets codified here with a minimum score assertion.
3. **Field A/B protocol (manual, per release).** Fixed task list on a real repo, same agent, with vs. without matha connected. Record: corrections the human had to make, repeated-mistake incidents, agent context tokens consumed. Small-n and subjective — but it's the honest headline number, and re-running the original 9/100 evaluation on each release shows trend. Target for v1.0: ≥ 70/100 on that rubric.

---

## 4. Roadmap — current state → v1.0

Ordered by dependency; each phase is independently shippable and leaves the tool strictly better.

### Phase 1 — "It actually works" (v0.2.0)
*Goal: everything the README already claims, true. No new features.*

- Fix brain-dir resolution (`core/resolve.ts`, resolution order per §1.4); plumb `serve --project`; adopt MCP `roots`; error instead of silent empty brain. Fixes current-state §2.1.
- One schema module with the one sanitizer (fixes §2.4); one tier… no — tier tables deleted along with dopamine/gates scope cut (§2.2, §2.3 become moot). `before`/`after` slim down to non-interactive brief-print and write-back helpers pending Phase 3.
- Register-or-delete pass: expose `matha_refresh_cortex`-equivalent, delete `mathaGetRouting`, dead params, `frontal-lobe.ts`, dead imports (§2.11, §2.13).
- `matha doctor` (brain path, record counts, staleness, config validity) + diagnostics field on every MCP response.
- `migrate` does its first real migration (stamp `schema_version`, normalize record envelopes) or exits honestly; fix placeholder URLs, server version from package.json, `typescript` → devDependencies, portable IDE config generation (Windows-safe launch command) (§2.7, §2.14).
- **Tests:** the end-to-end wiring test (§3.2). **Exit criterion:** field-eval rubric re-run scores ≥ 50/100 (from 9).

### Phase 2 — Retrieval core (v0.3.0)
*Goal: the right context surfaces, bounded tokens. Depends on Phase 1's engine/schema.*

- `retrieve/match.ts` scoring pipeline (§2) replacing substring matching; severity gated by score.
- `retrieve/brief.ts` profile-style, token-budgeted brief; consolidated MCP surface (`matha_brief`, `matha_match`, one write tool, refresh); MCP prompt injecting brief + standing record-instruction.
- Golden-set eval harness + fixtures in CI (§3.1) — built *with* the matcher, so tuning is data-driven from day one.
- **Exit criterion:** recall@5 ≥ 0.8, false-critical ≤ 0.05, every brief within budget.

### Phase 3 — Capture quality & coverage (v0.4.0)

*Goal: garbage can't get in; knowledge gets in without ceremony; work done outside matha degrades quality gracefully instead of silently.*

- Schema-validated writes (reject empty/trivial/unscoped records with readable reasons); near-duplicate detection on write (lexical similarity vs. existing records of same type).
- Write-tool descriptions that teach the agent when to record (dev-workflow triggers).
- Session-end capture via agent hooks (Claude Code hooks first: SessionStart injects brief, Stop prompts a structured write-back call); interactive interview demoted to fallback.
- Codemap auto-refresh on staleness (git HEAD moved > N commits since last derive), **incremental with a persisted commit cursor** — only new commits are ever processed; counts merge into existing records (§5.2).
- **Large/existing repos:** bounded, recency-weighted first analysis (default: last ~18 months or ~10k commits, whichever smaller; `--full` opt-in, streamed); monorepo scale via per-file records for the top-N high-history files and **directory-level rollups** for the rest — hierarchical matching hits rollups naturally (§5.2, §5.3).
- **Uncaptured-work reconciliation** (§5.1): per-record `possiblyStale` flag at read time (record's paths changed materially since it was written → surfaced with a rank penalty and marked in diagnostics); `matha catchup` lists commits since the last recorded session touching paths with no associated records and supports human- or agent-assisted backfill as `probable` records.
- **Existing-codebase onboarding:** `matha onboard` — agent reads project docs and proposes initial rules/boundaries as `probable` records; human confirms via `matha review` (extends today's `init --from`).
- **Exit criterion:** dogfood month produces zero garbage records; capture happens in ≥ 80% of sessions without a human running `matha after`; codemap refresh on a 10k-commit repo completes incrementally in seconds.

### Phase 4 — Lifecycle & curation (v0.5.0)
*Goal: the brain stays trustworthy as it ages.*

- Lifecycle operations end-to-end: supersede on conflicting decision, retire with reason, confirm (probable → confirmed) — via `matha review` (human) and the write tool (agent).
- Review queue: `matha review` lists unconfirmed/stale/possibly-stale records; confidence weighting already ranks them lower (Phase 2), review resolves them.
- Contract violations wired correctly (one sanitizer since Phase 1) so repeated violations escalate severity with evidence.
- **Visualization** (§5.4): `matha export --md` — generated human-readable, PR-diffable brain summary; `matha ui` — single self-contained HTML file (`.matha/report.html`, inline JS/CSS, no server, no deps): filterable records table, stability treemap, co-change graph. The HTML view doubles as the review-triage surface.
- **Declared boundaries + CI check** (§5.5): admin-authored pinned records (`declaredBy`, `confirmed`, no decay, always CRITICAL on path match), stored in the same JSON store so boundary changes are themselves PR-reviewed; `matha check --diff <base>` runs the matcher over a git diff's changed files and reports matched boundaries/zones/contracts with exit-code semantics — advisory by default; whether it blocks merge is the admin's CI config, not matha's.
- **Exit criterion:** every record in the dogfood brain is reachable, editable, and retirable without hand-editing JSON; `matha check` runs green in matha's own CI.

### Phase 5 — v1.0 polish
- Eval-driven tuning pass (embeddings tripwire decision per §2, with data).
- Field A/B on two real projects (§3.3), target ≥ 70/100 rubric.
- Windows CI, docs rewritten to match reality, semver + real migration story, npm publish hygiene.

### Explicitly cut / deferred beyond v1.0
- Model-tier routing & token-budget prediction (dopamine) — cut.
- Interactive 8-gate ceremony — cut (contracts survive as records).
- Embeddings/vector search — deferred behind eval tripwire.
- Team-sync/cloud anything — out of scope by design; the repo is the sync mechanism.

---

## 5. Design answers from the scope review (2026-07-11)

Questions raised when the §0 cut was approved, and the decisions taken. These are folded into Phases 3–4 above.

### 5.1 Work done outside matha (manual commits, non-MCP agents)

Two layers, two answers. The **codemap never misses** — it captures from the artifact (git history), so all work is covered regardless of who did it, once refresh is staleness-triggered. The **knowledge layer is opt-in by nature**: no tool can recover "the assumption that broke" from a commit after the fact, so the posture is *graceful degradation + reconciliation*, never silent pretending: (a) records are path-scoped, so at read time we detect that a record's paths changed materially after it was written and surface it flagged `possiblyStale` with a rank penalty — uncaptured work makes the brain less rich, never wrong; (b) `matha catchup` lists "unaccounted work" (commits since the last recorded session touching paths with no records) and supports human- or agent-assisted backfill as `probable` records that review can later confirm.

### 5.2 Existing codebases with large git history

Never re-scan, never scan everything: a **persisted commit cursor** makes every refresh incremental (only new commits, merged into existing counts). The first run is bounded and **recency-weighted by default** (last ~18 months or ~10k commits, whichever smaller) — a performance necessity that is also better signal, since five-year-old churn says little about today's stability; `--full` remains opt-in and streams `git log` rather than loading it in memory. Knowledge onboarding for existing repos: `init --from <docs>` (exists) plus `matha onboard` (agent proposes initial rules/boundaries from project docs as `probable`, human confirms).

### 5.3 Index depth vs. retrieval latency, and where context lives

The knowledge store is 10²–10³ records — a linear scan is microseconds; it never needs an index. The only scale risk is the codemap on monorepos: solved with per-file records for the top-N files with meaningful history (~5k) and **directory-level rollups** for the rest; hierarchical path matching means a deep file still hits its directory's rollup. The long-lived MCP server keeps everything in memory (mtime-invalidated), so warm retrieval is sub-millisecond — enforced by the eval harness's p95 latency metric. *Where context lives is decided at write time by the schema, not read-time heuristics:* every record must declare `paths` (file, dir, or glob — the author picks the altitude); unscoped records are project-global and live only in the brief's `static` section.

### 5.4 Visualizing the brain

Two zero-dependency, local-first outputs (Phase 4): `matha export --md` for a human-readable, PR-diffable summary, and `matha ui` for a single self-contained HTML report (records table with filters, stability treemap, co-change graph) written to `.matha/report.html`. No server, no cloud, nothing to install.

### 5.5 Admin boundaries without becoming an enforcer

Boundaries are the retrieval engine pointed at a diff — not a policy engine. Admins declare pinned records (confirmed, non-decaying, always CRITICAL on path match), stored in the same JSON store so boundary changes are themselves PR-reviewed. `matha check --diff <base>` matches a diff's changed files against the brain and reports findings with exit codes; it is advisory by default and whether CI blocks on it is the admin's choice. matha stays capture-store-retrieve; CI is just one more retrieval consumer.

---

## 6. Decision log

- **2026-07-11 — product boundary (§0): APPROVED.** matha v1.0 is the project-memory MCP server (capture → store → retrieve → eval). The process-enforcement half — dopamine tier routing, token-budget prediction, the interactive gate ceremony, contract pass/fail interviews — is removed rather than repaired. `before`/`after` become thin admin/fallback commands; README and MATHA_ROADMAP to be rewritten to match during Phase 1. Guardrail needs are met by §5.5 (declared boundaries + advisory `matha check`), not by enforcement ceremony.
- **Next decision point:** go-ahead on Phase 1 ("It actually works", v0.2.0).
