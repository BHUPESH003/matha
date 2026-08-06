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
- **2026-07-17 — Phase 1 SHIPPED (v0.2.0).** Brain resolution fixed and e2e-proven across a process boundary; one schema module/sanitizer; Engine with mtime-invalidated cache; hierarchical path matching; validated writes; `doctor`; real `migrate`; 193 tests.
- **2026-07-17 — Phase 2 SHIPPED (v0.3.0).** S×L×C×R scoring pipeline (structural + co-change expansion, BM25 lexical with small-corpus IDF smoothing, confidence weights, floored 180-day decay on decisions; severity gated by structural score). Token-budgeted brief (1,500 tokens, criticals ranked into the budget first, `tokenEstimate` reported). Consolidated MCP surface: `matha_brief` / `matha_match` / `matha_record` / `matha_refresh` + `matha_context` prompt. Golden-set eval harness in CI (synthetic fixture, 24 queries): recall@5 = 0.95 (gate ≥ 0.8), false-critical = 0.00 (gate ≤ 0.05), brief max 630/1500 tokens, warm p95 ≈ 2 ms. Known measured gap: concept-worded record vs path-worded query (1 query) — the §2 embeddings tripwire stays un-tripped while recall holds above target.
- **2026-07-17 — v0.3.0 published to npm and field-validated.** Registry package verified end-to-end (install → init → MCP round-trip from unrelated cwd). Headless Claude Code field test (scripts/field-test.sh): 3/3 — planted danger zone changed the code the agent wrote, agent recorded a well-formed decision, a fresh session inherited it. User's real-project test confirmed capture/retrieve across sessions.
- **2026-07-18 — MCP confidence cap (field finding).** A real agent self-assigned `confirmed` on day one, bypassing the review loop. `matha_record` now caps agent writes at `probable` (`uncertain` allowed); `confirmed` is reserved for human surfaces. Dogfooding wired in matha's own repo (.mcp.json + CLAUDE.md).
- **2026-07-18 — Phase 3 first batch SHIPPED (toward v0.4.0).** Incremental codemap: persisted commit cursor in cortex/analysis.json, refresh scans only cursor..HEAD and merges, bounded first run (18 months / 10k commits), rebase falls back to full rescan, deleted files pruned via ls-files. Auto-refresh on read: Engine compares cursor to git HEAD via plain file reads (no subprocess) and refreshes before serving retrieval — the codemap can no longer go silently stale. `possiblyStale`: records whose paths changed in git after they were written are flagged and rank-penalized (×0.75, 3-day grace), in matches and brief. Near-duplicate writes rejected (Jaccard ≥ 0.7) on both MCP and CLI paths, pointing at the existing record. `matha catchup` lists commits since the newest recorded decision touching paths no record covers, with a backfill hint. Remaining for v0.4.0: session-end capture via agent hooks, `matha onboard`.
- **2026-07-18 — Phase 3 COMPLETE, Phase 4 & 5 SHIPPED (v1.0.0).** Phase 3 remainder: `matha onboard` (emits an agent prompt from the project's own docs; proposals land `probable`, human confirms via review) and `matha hooks [--install]` (Claude Code SessionStart hook injecting the brief; `matha before` now ends with the standing write-back instruction — a Stop-hook prompt is deferred until dogfooding shows the standing instruction misses captures). Phase 4: lifecycle end-to-end — `matha_record` gains `violation` / `supersede` / `retire` (content stays append-only; lifecycle is metadata), `matha review` triages unconfirmed + possibly-stale records (confirm sets `last_confirmed`, resetting the staleness clock), declared boundaries (`matha boundary add/list`, CLI-only, pinned confirmed, no decay, CRITICAL only on S ≥ 0.8), `matha check --diff <base>` (advisory, `--strict` exits 1 on criticals), `matha export --md` (deterministic, PR-diffable) and `matha ui` (single self-contained HTML report doubling as the triage surface). Phase 5: GitHub Actions CI (ubuntu + windows matrix, vitest + eval gates, dogfood `matha check` on every push/PR), schema 1.0.0 (additive; migrate stamps), README/ide-workflow rewritten to match, eval after extension: recall@5 = 0.957, precision@5 = 0.797, false-critical = 0.000 (26 queries incl. boundary cases) — embeddings tripwire stays untripped.
- **2026-07-27 — field audit on a 1,919-commit / 917-file production repo (customer-portal frontend), v1.0.1 hardening.** Bounded first-analysis and incremental-refresh (§5.2) held exactly as designed on real scale (37× faster incremental vs. cold rebuild). Four real defects found and fixed:
  1. **`brief.truncated` false-positive** — the recency-ordered packing loops in `retrieve/brief.ts` used `break` on the first oversized record, silently dropping every smaller record sorted after it regardless of remaining budget headroom. Fixed to `continue` (skip, don't stop) in both the recentDecisions and matched loops. Root-caused and reproduced locally before fixing (tests/retrieve/brief.test.ts).
  2. **Near-duplicate rejection missed real paraphrases** — Jaccard word-overlap (≥0.7) is strict against asymmetric-length rewording; a realistic LLM paraphrase of an existing decision scored 0.22 Jaccard (missed) but 0.54 on overlap coefficient (intersection ÷ smaller set). Added overlap coefficient as a second signal (≥0.5, with a MIN_SHARED_WORDS=4 guard against short-text false positives) — still no embeddings, still no network dependency.
  3. **`matha review` crashed on non-TTY/piped stdin** (ExitPromptError from the prompt library) instead of degrading. Now detects non-interactive stdin and falls back to a plain report, matching `catchup`'s posture.
  4. **Frozen-file over-triggering** — on this repo 37% of files classified frozen, so `matha check --strict` flagged ~35% of an ordinary diff CRITICAL. Root cause: bounded/incremental analysis windows can make a historically active file's *observed* churn look low if most of its history falls outside the window. Fixed the classifier to veto `frozen` for any file touched in the last 60 days regardless of long-run average (`maxDaysSinceLastChangeForFrozen`) — this also self-corrects the check false-critical rate, since a file inside the diff being checked was by definition just touched. Added `frozenFileSeverity` in config.json as a per-repo escape hatch (default unchanged: `critical`).
  Also clarified in docs (not code changes): `truncated` signals a skipped record, not "response was cut short" — check `matchResults.length`/`tokenEstimate` for the real picture; `recentDecisions` is intentionally global, not scope-filtered, by design; the sub-10ms p95 eval figure describes warm in-process MCP retrieval, not CLI process-invocation time (150–250ms floor there is Node startup, not matha). 256/256 tests, eval unchanged (recall@5=0.957, falseCritical=0.000).
- **2026-07-28 — Windows CI red on first real run, v1.0.2.** The new ubuntu+windows CI matrix (added alongside the v1.0.1 fixes) caught a real bug on its first Windows run: `markdown-parser.ts` split content on `\n` only, leaving a trailing `\r` on every line when a fixture is checked out with CRLF — and JS regex `.` treats `\r` as a line terminator, so it never matches, silently failing every heading/bullet pattern (`why`/`rules`/`boundaries` all came back empty on Windows). Fixed by normalizing `\r\n?` → `\n` once at the top of `parseContent`, plus a `.gitattributes` (`* text=auto eol=lf`) so no future text fixture can hit this class of bug via checkout line-ending conversion. Regression test constructs CRLF content directly (independent of git checkout behavior). 257/257 tests.
- **2026-08-03 — v1.0.3: cortex/.gitignore, dependency trim, matha_match keyword search.** Four user questions surfaced three real gaps. (1) Multi-language usage was already fine (retrieval is path/git/text-based, not AST-aware; `detectStack` already checks package.json/tsconfig/requirements.txt/Cargo.toml/go.mod/pom.xml — cosmetic metadata only, never gates functionality) — documented rather than changed. (2) Parallel-work git conflicts: `.matha/cortex/` (analysis.json, stability.json, co-changes.json) is derived from git history and rebuilds itself on read, but was being committed like the human-authored `hippocampus/`/`cerebellum/` — guaranteeing non-mergeable JSON conflicts between branches for zero benefit. `matha init` now adds `.matha/cortex/` to `.gitignore` (creates the file if missing, skips if already covered by a broader `.matha/` entry, idempotent on re-run) — hippocampus/cerebellum stay committed since that's the actual shared knowledge. (3) Bundle size (bundlephobia showed 155kB/49.6kB gzip, mostly zod): traced via `npm ls` — zod/ajv/zod-to-json-schema are 100% transitive from the official `@modelcontextprotocol/sdk` (unavoidable without forking the SDK, not worth it) but `chardet`+`external-editor` were dragged in by `@inquirer/prompts` bundling every prompt type (checkbox/editor/select/...) when matha only ever calls `input()`. Swapped to the scoped `@inquirer/input` package — same behavior, `chardet` and `external-editor` dropped entirely from the tree. Also noted bundlephobia's browser-bundle framing (slow-3G download time) doesn't really apply to a locally-installed Node CLI/MCP-server; the actual analogous cost is `npx` cold-start/install size, which this shrinks. (4) No dedicated keyword-search tool existed — `matha_match` required both `scope` and `intent`. Made `scope` optional (matches `matha_brief`'s existing shape); `matchAll` already handled empty query-paths via the text-only structural floor (proven by an existing golden query), so this was a schema/wiring fix, not a scoring change — omitting scope is now a documented "keyword search over intent alone, never critical" mode. 262/262 tests.
- **2026-08-04 — gitignore fix narrowed to the 3 actually-regenerated files.** The v1.0.3 fix gitignored the whole `.matha/cortex/` directory, which also swallowed `boundaries.json` (free-text out-of-scope from init/markdown-seed), `ownership.json`, and `shape.json` — all written once at init time via `writeIfMissing` and never touched again, i.e. constant, human/seed-authored content that belongs in git same as hippocampus/cerebellum. Only `analysis.json`, `stability.json`, `co-changes.json` are ever rewritten (by `refreshFromGit`) and are the actual source of merge conflicts. `ensureCortexGitignored` now lists those three files explicitly instead of the directory; a pre-existing broad `.matha/` (or `.matha/cortex/`) ignore is still respected as already-covering. Caught by the user re-reading the diff rather than by tests — worth remembering: gitignore/scope-of-exclusion changes need a "what else lives in this directory" check before landing, not just "does this file regenerate."
- **2026-08-06 — decisions storage: one file per component, not per session.** Field use surfaced a directory-clutter problem: `hippocampus/decisions/` was one JSON file per recorded decision (named by session id or `timestamp-hash`), so a component touched across many sessions ended up scattered across many files instead of reading as one compiled history. Changed the on-disk shape to `decisions/<component>.json` = `{ component, decisions: DecisionEntry[] }` — the same array-in-file pattern `danger-zones.json` already used, just sharded per component instead of one global file. `recordDecision` appends to its component's file; `getDecisions(component)` becomes a single-file read instead of a full directory scan; `updateDecisionLifecycle` (retire/supersede/confirm) scans component files by id since callers only have the id, same cost as the old unscoped listing. Append-only still holds at the entry level — existing array entries are never rewritten except through the already-designed lifecycle-metadata exception. Trade-off worth naming: two sessions landing decisions on the *same* component at the same time now touch the same file (a real but small merge-conflict/lost-update surface, same shape as `danger-zones.json` already accepted) instead of each getting a collision-free file — judged a good trade given the clutter this fixes. Old repos upgrade via `migrateLegacyDecisions`, wired into `matha init` (idempotent, skips anything already grouped, ignores stray non-decision files instead of crashing on them — found one in matha's own dogfood brain, a leftover validation report with no `component` field). Migrated matha's own 25 legacy decision files down to 22 component files, zero data loss. 268/268 tests (+ new coverage: grouping, migration idempotency, malformed-file resilience, init upgrade path).
- **Next decision point:** publish to npm (pending user's package-name decision + npm 2FA), then continue field validation on remaining large codebases with this hardening in place. Deferred beyond v1.0: Stop-hook write-back prompt, monorepo directory rollups, interactive catchup backfill, danger-zone timestamps (possiblyStale for zones), cortex/boundaries.json (free-text out-of-scope from init) vs hippocampus/boundaries.json (Phase 4 declared BoundaryRecord[]) naming collision — different paths/shapes, not a bug, but confusing enough to warrant a rename later.
