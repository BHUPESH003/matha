# matha — Current State Analysis

**Date:** 2026-07-11
**Version analysed:** 0.1.9 (commit 234d1ab)
**Method:** full source read (~4.7k lines), test run (262/262 pass), build verification, live reproduction of suspected bugs, inspection of the repo's own dogfood `.matha/` data, and cross-reference against the prior field evaluation (`docs/matha_evaluation_report.md`, scored 9/100).

---

## 1. System Map

### Entry points

| Surface | File | Notes |
|---|---|---|
| CLI | `src/index.ts` | commander; subcommands `init`, `before`, `after`, `migrate`, `serve` |
| MCP server | `src/mcp/server.ts` | stdio transport, started via `matha serve` or direct `node dist/index.js serve` |

### The three commands

- **`init`** (`src/commands/init.ts`) — creates the `.matha/` tree, interactively prompts for WHY / rules / boundaries / owner (optionally seeded from a markdown file via `--from` + `src/utils/markdown-parser.ts`), derives project "shape" (top-level dirs, stack detection, file count), runs a git-history analysis to build the cortex, and writes `.matha/mcp-config.json` with an MCP server config for the IDE.
- **`before`** (`src/commands/before.ts`) — interactive "gates 01–06": asks what you're building and the scope, prints cortex stability info, runs the contract matcher against stored knowledge, collects behaviour-contract assertions, asks operation type, gets a model-tier/token-budget recommendation, then writes `sessions/<id>.brief` and `dopamine/predictions/<id>.json` and prints a copy-pasteable session brief.
- **`after`** (`src/commands/after.ts`) — interactive write-back: asks what assumption broke (→ decision), whether to record a danger zone, walks through contract assertions pass/fail, asks files-changed and tokens-used, then writes a decision file, danger zone, `dopamine/actuals/<id>.json`, appends to `dopamine/deltas.json`, and logs contract violations.

### The brain modules (`src/brain/`)

| Module | Role | Storage |
|---|---|---|
| `hippocampus.ts` | intent, rules, decisions, danger zones, open questions | `hippocampus/intent.json`, `rules.json`, `decisions/*.json` (one file per decision), `danger-zones.json`, `open-questions.json` |
| `cortex.ts` | git-derived file stability + co-change map | `cortex/stability.json`, `co-changes.json`, plus init-time `shape.json`, `boundaries.json`, `ownership.json` |
| `dopamine.ts` | prediction-vs-actual token/tier learning | `dopamine/predictions/`, `actuals/`, `deltas.json`, (`routing-rules.json` — never written, see §2.2) |
| `frontal-lobe.ts` | gate state machine + brief generation | none (pure functions) — **largely dead code**, see §2.13 |
| (cerebellum) | behaviour contracts + violation log | `cerebellum/contracts/*.json`, `violation-log.json` — **no module exists**; written directly by `mcp/tools.ts` and `commands/after.ts` |

### Analysis layer (`src/analysis/`)

- `git-analyser.ts` — walks up to 500 commits via simple-git, produces per-file change counts, authors, dates, and top-50 co-change pairs.
- `stability-classifier.ts` — pure heuristic over churn rate + age + co-change connectivity → `frozen | stable | volatile | disposable` with confidence.
- `contract-matcher.ts` — `matchAll(context)` checks the scope/intent against danger zones, contracts, frozen files, and prior decisions; returns severity-sorted `MatchResult[]`. **This is the entirety of the retrieval engine, and it is substring matching** (see §2.6).

### Storage layer (`src/storage/`)

`reader.ts` (`readJson`, `readJsonOrNull`) and `writer.ts` (`writeAtomic` temp-file+rename, `appendToArray`, `mergeObject`). Solid, well-tested, genuinely atomic.

### MCP surface (`src/mcp/`)

9 registered tools (`server.ts:55-233`): reads `matha_get_rules`, `matha_get_danger_zones`, `matha_get_decisions`, `matha_get_stability`, `matha_brief`, `matha_match`; writes `matha_record_decision`, `matha_record_danger`, `matha_record_contract`. Two more are implemented in `tools.ts` but **never registered**: `mathaGetRouting` (tools.ts:455) and `mathaRefreshCortex` (tools.ts:490).

### How context flows

1. **Capture** is 100% manual: humans answer CLI prompts, or the agent voluntarily calls `matha_record_*`. Nothing is captured automatically from the work itself (despite the README claiming "captured automatically from the work itself").
2. **Storage** is plain JSON files in the repo. No index of any kind; every retrieval re-reads and re-scans all files.
3. **Retrieval** is `matchAll`: case-insensitive substring containment between the caller's scope/intent strings and stored components/descriptions, plus a >4-char keyword extractor. No ranking beyond a 3-level severity sort, no relevance score, no token budgeting of the output.
4. **Surfacing**: the `before` CLI prints a brief to paste manually, or the agent calls `matha_brief`/`matha_match` over MCP and gets a JSON blob.

---

## 2. What Is Actually Broken or Half-Implemented

Ordered by severity. Items marked ✅ were reproduced live during this analysis.

### 2.1 ✅ MCP server resolves the wrong brain (root cause of the 9/100 field eval)

`src/mcp/server.ts:358-410`. The server locates `.matha/` by walking **up** from `process.cwd()` — but the cwd of an MCP server process is set by the IDE/client, frequently not the project root. There is also a positional `process.argv[3]` "explicit root", which nothing ever passes correctly:

- `src/index.ts:108-126` — the `serve` action parses `--project` into `options.project`... and then never uses it. It dynamically imports `server.js` with no arguments.
- The server then reads `argv[3]`, which for `matha serve --project /x` is the literal string `--project`. **Reproduced:** running `matha serve --project /tmp/foo` creates a directory literally named `--project/` in the cwd and serves an empty brain from `--project/.matha`.
- When the upward search fails, the server silently `mkdir`s a fresh empty `.matha` and serves defaults — no error, no warning to the client.

This single defect explains most of the field evaluation's findings: rules existed in the project's `.matha/` but `get_rules()` returned matha's own framework rules (the server had found a different `.matha/` up the tree), and `get_stability()` returned null for every file (empty/wrong brain). **The brain works; the server points it at the wrong skull.**

Related config brittleness: `init` writes absolute paths into `.matha/mcp-config.json` and `config.json` (`project_root`). This repo's own committed config points at `/home/pelocal/Desktop/matha` — the repo has moved since, and nothing detects or repairs that.

### 2.2 ✅ The dopamine loop never closes

The learning pipeline is: deltas accumulate → `analyseDeltas()` builds routing rules → `persistAnalysis()` writes `dopamine/routing-rules.json` → `getRecommendation()` reads it. But `analyseDeltas`/`persistAnalysis` are only reachable through `mathaGetRouting` (`src/mcp/tools.ts:455-479`), which is **not registered** in the MCP server and **not called** by `after.ts` or anywhere else. Consequence: `routing-rules.json` never exists (confirmed: absent from this repo's own `.matha/dopamine/` after 3 dogfood sessions), and `getRecommendation` (`src/brain/dopamine.ts:201`) always returns `source: 'default'`. The entire "every session starts warmer" learning claim is a no-op. All the `rec.source === 'learned'` display logic in `before.ts:216-229` is unreachable.

### 2.3 ✅ Default tier tables disagree — `rename`/`crud` silently become `mid/4000`

`src/brain/dopamine.ts:44-50` keys its defaults with the combined string `'rename/crud'`, but actual operation types are `'rename'` and `'crud'` (`src/commands/before.ts:27-33`). So `DEFAULT_TIERS['rename']` is undefined and falls through to `'unknown'` → `mid`/4000 — while `before.ts:36-42` has its own second table saying `lightweight`/2000, used only for the "upgraded/downgraded" display message. **Evidence:** this repo's own `dopamine/deltas.json` records `operation_type: "rename", model_tier_used: "mid"`. Two sources of truth, both wrong together.

### 2.4 Contract violations can never update contracts (sanitizer mismatch)

Contracts are written to `cerebellum/contracts/<name>.json` with `component.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()` (`src/mcp/tools.ts:348-350`). Violation write-back looks the file up with `component.replace(/[^a-zA-Z0-9_-]/g, '_')`, no lowercasing (`src/commands/after.ts:362`). For any component containing `/`, `.`, a space, or an uppercase letter — i.e. any real file path — the two names differ (`src/auth.ts` → `src-auth.ts` vs `src_auth_ts`), so `violation_count` is never incremented, `last_violated` never set, and `matchContracts`' critical-severity escalation (`src/analysis/contract-matcher.ts:86-95`) is dead code in practice.

### 2.5 Two disconnected "contract" stores

`before` collects assertions into the session brief only (`before.ts:241-265`); `matha_record_contract` writes to `cerebellum/contracts/`. The contract matcher reads **only** `cerebellum/contracts/`. So the contract you write in the flagship `before` flow is invisible to next session's matching unless the agent separately calls `matha_record_contract`. The violation log in `after` similarly validates the *brief's* assertions, then tries to update the *cerebellum* contract (and fails per §2.4).

### 2.6 Retrieval is substring matching, brittle in both directions

`src/analysis/contract-matcher.ts`:

- **Empty component matches everything:** `scopeLower.includes(compLower)` where `compLower` is `''` returns `true` (`contract-matcher.ts:50`, same pattern at :85 and :171). A single danger zone recorded with a blank/whitespace component fires a CRITICAL warning on every operation forever.
- **Misses trivially:** the scope string must *contain* the stored component string. A zone recorded against `payments module` will never match scope `src/payments/retry.ts`. The field eval hit exactly this: 12 well-formed stored rules, zero surfaced in `matha_brief` matches.
- Keyword extraction (`extractKeywords`, :32) is a >4-char/stop-word filter over the intent only for danger zones; there is no stemming, no scoring, no ranking — results are only sorted by 3-level severity.
- No token cost control: `matha_brief` returns the whole brief + all matches; `matha_get_decisions` has no default limit; `matha_get_rules` returns everything always.

### 2.7 ✅ `migrate` is a stub that other code actively points at

`src/commands/migrate.ts` prints "Migration not required" / "arrives in v0.2.0" and exits 0 (with a placeholder URL `github.com/your-username/matha`). Meanwhile `checkSchemaVersion` (`src/utils/schema-version.ts:85-111`) tells every legacy/outdated user to *run* `matha migrate`. This repo's own `.matha/config.json` lacks `schema_version`, so every command here prints the legacy warning and the recommended fix does nothing. `migrate.ts:1` also duplicates the schema constant instead of importing `CURRENT_SCHEMA_VERSION`.

### 2.8 Capture quality: free-text prompts record garbage as durable memory

`after.ts` accepts any non-empty string as a "decision". This repo's own brain contains a committed decision with `previous_assumption: "y", correction: "y"` (`.matha/hippocampus/decisions/20260307-221610-183e-decision.json`) — a y/n answer captured as permanent knowledge. The field eval likewise found danger zones with descriptions `"type errors"` and `"1500"`. There is no validation, no review step, no way to edit/retire bad entries (no CLI/MCP surface for `status: superseded/invalidated` even though the schema has the field).

### 2.9 Cortex goes stale; refresh tool exists but is unreachable

The cortex is built once at `init` (`init.ts:172-187`). `mathaRefreshCortex` (`tools.ts:490`) is implemented but not registered in the MCP server, and there is no CLI command for it. `before.ts` reads the snapshot but never refreshes. Additionally `getSnapshot` (`cortex.ts:308`) tries to read `repoPath` from `shape.json`'s `project_root` key — which `init`'s `deriveShape` never writes (it writes `directories/detected_stack/file_count`), so `repoPath` is always `''` and `commitCount` is hardcoded 0.

### 2.10 Duplicated, divergent stability lookup

`mathaGetStability` (`tools.ts:79-114`) reimplements lookup with lowercase + leading-slash-stripped comparison instead of calling `cortex.getStability` (exact-match after backslash normalisation, `cortex.ts:187`). CLI `before` uses the cortex version; MCP uses the tools version. Same query, different answers depending on surface — and neither handles relative-vs-absolute paths, which is what nulled every lookup in the field eval.

### 2.11 Dead parameters and dead exports

- `mathaBrief(mathaDir, scope, directory)` — the entire `directory` filter mode (`tools.ts:120-189`, ~70 lines) is unreachable: the server never passes a third argument and the tool schema has no such property.
- `mathaMatchToolDefinition` (`tools.ts:422-448`) duplicates the inline definition in `server.ts:200-232`; the export is used by nothing but tests.
- `hippocampus.ts:3` imports `mergeObject`, never used. `tools.ts:3-4` imports `appendToArray`, never used. `before.ts:3` imports `readJson`, never used.
- `getOpenQuestions`/`recordOpenQuestion` (`hippocampus.ts:210-244`) have no caller outside tests — the open-questions feature has storage but no surface.

### 2.12 ✅ Dev-mode CLI breaks outside the repo directory

`npx tsx src/index.ts <cmd>` fails with `Cannot find package '@/storage'` when run from any other cwd (reproduced) — the `@/` alias resolves via tsconfig only in-repo. Production `dist/` is fine (tsc-alias rewrites), but every "test it quickly on another project" path during development hits this.

### 2.13 `frontal-lobe.ts` is a parallel, unused implementation

`runGate`, `validateSequence`, `generateBrief`, `runWriteBack` (320 lines) model the 8-gate flow — but `before.ts`/`after.ts` reimplement the flow inline and import only two *types* from it. Also its `routeOperation` (:266) is a third copy of the tier/budget table. Only tests exercise this module. Either the commands should be built on it, or it should be deleted; today it's drift risk.

### 2.14 Packaging & config issues

- `typescript` is a runtime `dependency` (package.json) — belongs in devDependencies; it bloats every consumer install.
- `init` writes an MCP config that runs `node node_modules/.bin/matha` — the `.bin` shim works on Linux/macOS (symlink to a JS file) but is a `.cmd`/`.ps1` script on Windows, which `node` cannot execute. The fallback path `<project>/dist/index.js` doesn't exist for consumers at all (`init.ts:365-375`).
- `server.ts:37-41` hardcodes version `0.1.0` while the package is 0.1.9.
- Test pollution committed at repo root: `.matha-test-matcher/` (a fixture directory some test wrote into the repo instead of a temp dir).
- The repo's own `.matha/` (with garbage decisions, stale absolute paths, 21 hand-written `session-NNN.json` fixtures) is committed — fine for dogfooding transparency, but it's what the MCP server serves to any agent working on matha itself (see §2.1's wrong-brain hazard).

---

## 3. Honest Quality Assessment

### Code quality: prototype-good, production-thin

The good: consistent style, a real atomic-write storage layer, a disciplined never-throw policy at module boundaries, small files, no dependency bloat (5 runtime deps, one of which shouldn't be there). Someone thought about failure modes at the unit level.

The bad, in order of importance:

1. **Silent-failure culture.** The never-throw discipline is applied so uniformly (`catch { return [] }`, `catch { /* ignore */ }` appears ~30 times) that every integration failure is invisible. The field eval is the proof: the server served the wrong/empty brain and returned well-formed empty JSON with no hint anything was wrong. Errors are swallowed exactly where the user most needs to see them.
2. **Duplication instead of boundaries.** Three tier/budget tables (`before.ts`, `dopamine.ts`, `frontal-lobe.ts` — mutually inconsistent, §2.3), two stability lookups (§2.10), two contract-name sanitizers (§2.4), two tool definitions (§2.11), two brief builders (`before.ts` inline vs `frontal-lobe.generateBrief`), two schema constants (§2.7). Most of the concrete bugs in §2 are two copies of the same concept disagreeing.
3. **Surface/wiring gaps.** Implemented-but-unregistered tools, dead parameters, features with storage but no read path (open questions) or read path but no write path (routing rules). The pattern: modules were built and unit-tested to a spec, and the last-mile wiring into the CLI/MCP surface was never verified end-to-end.
4. The brain metaphor (hippocampus/cortex/cerebellum/dopamine/frontal-lobe) is charming but actively obscures function — "cerebellum" has no module, "frontal lobe" is dead code, and a contributor must learn the metaphor before they can navigate. Worth reconsidering in the target architecture.

### Architecture

The layering idea is right (storage → brain → analysis → surface) and mostly respected downward. But there is **no composition root**: each surface (CLI command, MCP tool) re-assembles its own pipeline with its own constants, which is exactly where the divergence bugs breed. The single most valuable structural change would be one shared "engine" module that owns brain-dir resolution, the tier table, matching, and brief assembly — with CLI and MCP as thin adapters over it.

### Test coverage: high numbers, wrong pyramid

262 tests, all passing, over 16 files — genuinely good unit coverage of `storage/`, `analysis/`, `brain/`, and the command functions (with injected `ask`/`log` deps). But:

- **Zero tests for `src/mcp/server.ts`** — tool registration, argument dispatch, and brain-dir resolution: precisely the layer that scored 9/100 in the field.
- **Zero end-to-end tests** (init → record → new-process MCP serve → brief/match round-trip). Every §2 wiring bug would have been caught by one such test.
- Tests exercise `frontal-lobe.ts` and `mathaBrief`'s dead `directory` mode — coverage of code that production never runs, which inflated confidence.

The 262/262 green suite coexisting with a 9/100 field score is the whole lesson: the units are fine, the product is the wiring, and the wiring is untested.

### Summary verdict

matha 0.1.9 is a well-intentioned prototype whose storage and analysis layers are real, but whose two actual products — the MCP surface and the learning loop — are respectively mis-wired (§2.1) and unclosed (§2.2). Retrieval is naive substring matching that both over-fires (empty components) and under-fires (path vs. concept mismatch), with no relevance ranking and no token budgeting. The capture UX invites garbage into permanent memory with no curation path. None of this is architecturally fatal; almost all of it is last-mile integration debt, which is fixable — but "fix the wiring and prove it end-to-end" must come before any new features.
