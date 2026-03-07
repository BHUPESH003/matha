# Contributing to MATHA

MATHA is a persistent cognitive layer for AI-assisted development. This document covers everything you need to contribute effectively.

---

## Getting Started

**Prerequisites:** Node.js 20+, npm

```bash
git clone https://github.com/your-username/matha.git
cd matha
npm install
```

**Build:**
```bash
npm run build
```

**Run tests (single pass):**
```bash
npx vitest run
```

**Run tests in watch mode:**
```bash
npx vitest
```

---

## Project Structure

```
src/
├── storage/     Atomic file I/O layer
├── brain/       The five cognitive components
├── analysis/    Git analysis, stability, contract matching
├── commands/    CLI commands
├── mcp/         MCP server and tool definitions
└── utils/       Schema versioning, markdown parsing, session IDs
```

**`storage/`** — All `.matha/` reads and writes go through here. `reader.ts` handles safe JSON reads that return null on missing files. `writer.ts` handles atomic writes that guarantee no partial state on disk. Never use `fs` directly anywhere else in the codebase.

**`brain/`** — The five cognitive components. Each owns a specific subdirectory of `.matha/` and exposes a clean async API. `hippocampus` holds rules, decisions, danger zones. `cortex` holds the git-derived stability map. `frontal-lobe` holds session logic and model routing defaults. `cerebellum` holds behaviour contracts and violations. `dopamine` accumulates session deltas and derives learned routing rules.

**`analysis/`** — Git analysis (`git-analyser.ts`), stability classification (`stability-classifier.ts`), and contract matching (`contract-matcher.ts`). Pure functions where possible. No direct `.matha/` writes — brain components handle persistence.

**`commands/`** — Thin orchestration layer only. `init.ts`, `before.ts`, `after.ts`, `migrate.ts`. Business logic belongs in `brain/` or `analysis/`. Commands wire together brain calls, handle user prompts, and write session briefs.

**`mcp/`** — The MCP server (`server.ts`) and all tool handler functions (`tools.ts`). Exposes the brain to AI agents via the Model Context Protocol. Tools always return JSON strings and never throw to the caller.

**`utils/`** — Schema versioning (`schema-version.ts`), markdown file parsing for `matha init --from` (`markdown-parser.ts`), session ID generation.

---

## The One Rule

**Every write to `.matha/` goes through `storage/writer.ts`.**

No direct `fs.writeFile` calls anywhere in the codebase. This is how atomic writes and data integrity are guaranteed. If a write fails midway, the existing file is left intact. PRs that bypass `writeAtomic` or `appendToArray` will not be merged.

---

## Adding A New MCP Tool

1. Define the tool handler function in `src/mcp/tools.ts` — async, returns `Promise<string>` (JSON)
2. Type all inputs explicitly — no `any` for parameters
3. Wrap the entire handler body in `try/catch` — never throw to the MCP caller
4. Register the tool in `src/mcp/server.ts` with a `description` that explains what the tool does and any side effects
5. Add tests in `tests/mcp/tools.test.ts` — cover the happy path, the empty-data path, and the error path
6. Update `docs/ide-workflow.md` if the tool is user-facing

---

## Adding A New Brain Component

Brain components own a directory in `.matha/` and expose async methods. Rules:

- **Never throw** — return `null`, empty arrays, or a typed empty struct on missing or malformed data
- **Never call `fs` directly** — use `storage/reader.ts` (`readJsonOrNull`) and `storage/writer.ts` (`writeAtomic`, `appendToArray`)
- **Export all types** used by other modules — commands and MCP tools depend on these types
- **Every method needs a test** in `tests/brain/` — include the missing-data case

---

## Running A Full Validation

The smoke test that matters most:

```bash
npm run build
node dist/index.js init        # on a test project directory
node dist/index.js before
# answer the gates
node dist/index.js after
# answer the write-back prompts
```

Validation scripts in `/tmp/` using the injectable `ask`/`log` interface are useful for non-interactive testing — see `tests/commands/before.test.ts` for the pattern.

---

## Submitting A PR

- **One concern per PR** — a bug fix and a feature in the same PR will be asked to split
- **Tests must pass:** `npx vitest run`
- **Types must pass:** `npx tsc --noEmit`
- **New behaviour needs new tests** — if it can break, it needs a test
- **Update `docs/`** if the user-facing behaviour, a CLI flag, or an MCP tool changes

Commit messages follow the conventional commits format: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.

---

## Deferred Work (v0.2.0)

The following are explicitly out of scope for v0.1.0:

- **`matha migrate` (full implementation)** — schema migration logic for projects created on older versions. The stub exists and exits cleanly.
- **Git commit hook** — automatic `matha after` on `git commit`. Scoped out to avoid enforcing Git workflow assumptions.
- **Team / multi-owner support** — MATHA is currently single-developer. Conflict resolution for concurrent `.matha/` writes is v0.2.0.
- **Semantic contract matching** — contracts currently match on string overlap. v0.2.0 will use embedding-based similarity.
- **Component-level dopamine confidence** — the dopamine loop currently accumulates per operation type. Per-component tuning is v0.2.0.

Track progress on all of these in the issues tab.
