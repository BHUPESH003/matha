# matha — Project Roadmap & Implementation Guide
### The Persistent Cognitive Layer for AI-Assisted Development

---

## 0. How To Use This Document

This roadmap is the behaviour contract for matha itself. It is not a
specification to be interpreted — it is a sequence to be followed. Before any
AI agent writes a single line of code, it must read this document in full.

This document applies the matha framework to its own construction. Every
section maps to a component of the brain we designed. The order of sections
is the order of operations. Skipping sections is not permitted.

---

## 1. THE WHY (Hippocampus — Layer 1)

### The Problem matha Solves

Every AI coding session starts cold. The agent has no memory of what was
built yesterday, why a decision was made last week, or what assumption broke
in the last version. A senior engineer carries years of project context in
their head. An AI agent carries zero between sessions.

This is not a model intelligence problem. It is an architectural absence.
The knowledge exists — in conversations, in corrections, in "no that's wrong"
moments — but it evaporates the instant a session ends.

matha is the layer that captures that knowledge as a by-product of the
work itself, stores it durably in the project repository, and surfaces it
to any AI agent before it is allowed to write code.

### The Core Insight

The goal is not to make AI smarter. The goal is to give AI the same operating
environment that great engineers operated inside — ownership maps, decision
logs, behaviour contracts, quality gates — so that existing intelligence
becomes reliably accessible instead of randomly applied.

### What matha Is

- A local MCP server that runs alongside your project
- A persistent knowledge graph that lives in your repository (.matha/)
- A process enforcer that gates AI operations through structured checkpoints
- IDE agnostic, model agnostic, language agnostic, platform agnostic
- Open source. Neutral. Owned by nobody.

### What matha Is NOT

- Not an IDE or code editor
- Not an AI model or agent
- Not a replacement for version control
- Not a documentation generator
- Not a CI/CD pipeline
- Not a testing framework (it uses tests, it does not replace them)
- Not a cloud service (all data stays local in your repository)
- Not another markdown file the AI reads and ignores

---

## 2. THE BOUNDARY (Hippocampus — Layer 5)

### Explicit Exclusions

matha does not generate code. It gates, contextualises, and validates the
work of agents that do.

matha does not store code snippets. It stores intent, decisions, business
rules, danger zones, and behaviour contracts.

matha does not replace CLAUDE.md or AGENTS.md. It makes them unnecessary
by capturing what those files attempt to capture — automatically, from the
work itself, not from humans writing after the fact.

matha does not require a specific AI model. Any model that supports MCP
works. Any tool that supports MCP works.

---

## 3. THE BRAIN ARCHITECTURE (Cortex — Shape Layer)

matha is implemented as five interconnected components. They are not
independent modules — they feed each other continuously.

```
HIPPOCAMPUS   →  Long-term memory
               Intent, business rules, decision log, danger zones
               Confidence scores per component

CEREBELLUM    →  Behaviour contract
               Assertions written before code
               Grows from every correction and discovery
               Fires warning when pattern matches known failure

FRONTAL LOBE  →  Process enforcer
               8-gate sequence — structural, not prompt-based
               Coordinates all other components
               Cannot be skipped or overridden

CORTEX        →  Living knowledge graph
               5 layers: Shape, Stability, Intention, Ownership, Boundary
               3 sources: Git history, Conversations, Test results
               Mix of derived (automatic) and declared (human)

DOPAMINE LOOP →  Objective quality signal
               4 signals: Behaviour, Complexity, Cost, Knowledge
               Mechanism: predict → measure → delta → update
               Drives model routing from learned project history
```

---

## 4. THE FRONTAL LOBE — 8-GATE SEQUENCE

This sequence is the heart of matha. Every AI operation must pass through
these gates in order. The implementation must enforce this structurally — not
through prompting, but through actual gate validation before proceeding.

```
GATE 01 — UNDERSTAND
  Question: What is the WHY of this change?
  Not the feature. The problem it solves.
  Output: Feeds Hippocampus Layer 1
  Type: READ-DO (must be completed before proceeding)

GATE 02 — BOUND  
  Question: What are the non-negotiable rules for this area?
  What must not be violated regardless of implementation choice?
  Output: Feeds Hippocampus Layer 2
  Type: READ-DO

GATE 03 — ORIENT
  Question: What already exists that is relevant to this change?
  Who owns the affected components? What is their stability?
  Output: Reads from Cortex
  Type: DO-CONFIRM (system derives, human confirms)

GATE 04 — SURFACE DANGER
  Question: Has the Hippocampus seen failure in this area before?
  Are any danger zones activated by this operation?
  Output: Warning surfaced if match found
  Type: DO-CONFIRM (automatic match, human acknowledges)

GATE 05 — CONTRACT FIRST
  Question: What does success look like in machine-verifiable terms?
  Write the behaviour assertions before writing any implementation.
  Output: Feeds Cerebellum
  Type: READ-DO (contract must exist before BUILD gate opens)

GATE 06 — COST CHECK
  Question: What model tier is appropriate for this operation?
  What is the expected token budget? What is the complexity estimate?
  Output: Feeds Dopamine Loop prediction
  Type: DO-CONFIRM (system suggests, human confirms)

GATE 07 — BUILD
  The AI agent is now permitted to generate code.
  Constrained by: Hippocampus context, Cerebellum contract,
                  Cortex ownership map, cost budget
  Validation: Cerebellum assertions must pass before this gate closes
  Type: READ-DO

GATE 08 — WRITE BACK
  Question: What was learned? What assumption broke?
  What new rule was discovered? What should be remembered?
  Dopamine delta calculated: predicted vs actual
  Writes back to: Hippocampus, Cortex, Cerebellum, Dopamine history
  Type: READ-DO (mandatory — session is not complete without this)
```

---

## 5. THE .matha/ DIRECTORY STRUCTURE

This directory lives in the project root. It is committed to version control.
It is the persistent brain of the project.

```
.matha/
├── config.json                    # matha configuration
├── hippocampus/
│   ├── intent.json                # WHY the project exists
│   ├── rules.json                 # Non-negotiable business rules
│   ├── decisions/                 # One file per decision event
│   │   └── [timestamp].json
│   ├── danger-zones.json          # Known failure patterns
│   └── open-questions.json        # Unresolved uncertainties
├── cerebellum/
│   ├── contracts/                 # Behaviour contracts per component
│   │   └── [component-name].json
│   └── violation-log.json         # History of contract violations
├── cortex/
│   ├── shape.json                 # Core vs peripheral map
│   ├── stability.json             # Frozen/stable/volatile/disposable
│   ├── intention.json             # Why each part exists
│   ├── ownership.json             # Who understands what
│   └── boundaries.json            # What the system does NOT do
├── dopamine/
│   ├── predictions/               # Pre-operation predictions
│   │   └── [session-id].json
│   ├── actuals/                   # Post-operation measurements
│   │   └── [session-id].json
│   ├── deltas.json                # Accumulated prediction errors
│   └── routing-rules.json         # Learned model routing
└── sessions/
    └── [timestamp].brief          # Session briefs (output of engram before)
```

---

## 6. THE MCP SERVER INTERFACE

matha exposes the following MCP tools. These are the contract between
matha and any AI agent that connects to it.

```
TOOLS (read operations):
  matha_brief(scope?)
    Returns: session brief with relevant context, danger zones,
             contracts, and stability data for the current operation scope

  matha_get_rules(component?)
    Returns: non-negotiable business rules, optionally filtered by component

  matha_get_contract(component)
    Returns: behaviour contract (assertions) for named component

  matha_get_stability(files[])
    Returns: stability classification for each file (frozen/stable/volatile/disposable)

  matha_get_decisions(component?, limit?)
    Returns: decision log entries, optionally filtered by component

  matha_get_danger_zones(context?)
    Returns: known danger zones, optionally matched to current context

TOOLS (write operations):
  matha_record_decision(component, assumption, correction, trigger, confidence)
    Writes: new decision entry to hippocampus/decisions/

  matha_record_contract(component, assertions[])
    Writes: behaviour contract to cerebellum/contracts/

  matha_record_danger(component, pattern, description)
    Writes: new danger zone to hippocampus/danger-zones.json

  matha_record_delta(session_id, predicted, actual)
    Writes: dopamine delta, updates routing rules

  matha_update_stability(file, classification, reason)
    Writes: stability update to cortex/stability.json
```

---

## 7. THE DATA SCHEMAS

### Decision Entry (hippocampus/decisions/[timestamp].json)
```json
{
  "id": "uuid",
  "timestamp": "ISO8601",
  "component": "string",
  "previous_assumption": "string",
  "correction": "string",
  "trigger": "string (what caused the discovery)",
  "confidence": "confirmed | probable | uncertain",
  "status": "active | superseded | invalidated",
  "supersedes": "decision-id | null",
  "session_id": "string"
}
```

### Behaviour Contract (cerebellum/contracts/[component].json)
```json
{
  "component": "string",
  "version": "integer",
  "last_updated": "ISO8601",
  "assertions": [
    {
      "id": "string",
      "description": "string (human readable)",
      "type": "invariant | precondition | postcondition | edge_case",
      "status": "active | violated | deprecated",
      "violation_count": "integer",
      "last_violated": "ISO8601 | null"
    }
  ]
}
```

### Cortex Node (cortex/stability.json entry)
```json
{
  "path": "string (file or directory)",
  "stability": "frozen | stable | volatile | disposable",
  "classification_source": "derived | declared",
  "reason": "string",
  "owner": "string | null",
  "last_changed": "ISO8601",
  "change_frequency": "integer (changes per month, derived from git)",
  "blast_radius": "integer (files affected when this changes, derived)",
  "confidence": "high | medium | low"
}
```

### Dopamine Session (dopamine/predictions/[session-id].json)
```json
{
  "session_id": "string",
  "timestamp": "ISO8601",
  "operation_type": "rename | crud | business_logic | architecture | frozen_component",
  "scope": "string[]  (files/components expected to be touched)",
  "predicted": {
    "files_touched": "integer",
    "test_pass_rate": "float",
    "model_tier": "lightweight | mid | capable",
    "token_budget": "integer"
  },
  "actual": {
    "files_touched": "integer | null",
    "test_pass_rate": "float | null",
    "model_tier": "string | null",
    "tokens_used": "integer | null"
  },
  "delta": {
    "files_delta": "integer | null",
    "test_delta": "float | null",
    "cost_delta": "integer | null",
    "routed_to": "string | null"
  }
}
```

---

## 8. THE THREE CLI COMMANDS (MVP)

matha's MVP is three commands. Nothing more. The full MCP server runs
behind all three. These are the user-facing surface of the entire brain.

### Command 1: matha init

```
PURPOSE:
  Initialises matha for a project. Creates .matha/ directory.
  Starts the MCP server configuration. Runs Gates 01 and 02 interactively
  to seed the Hippocampus from the first conversation.

INTERACTIVE PROMPTS:
  1. "What problem does this project solve? (The WHY, not the features)"
  2. "What are the non-negotiable business rules? (Add one per line)"
  3. "What does this project explicitly NOT do? (Boundary map)"
  4. "Who owns this project? (For ownership map)"

DERIVED ON INIT:
  - Cortex shape from existing codebase (if any)
  - Stability classification from git history (if any)
  - Initial cortex from directory structure

OUTPUT:
  - .matha/ directory created
  - hippocampus/intent.json populated
  - hippocampus/rules.json populated
  - cortex/boundaries.json populated
  - cortex/shape.json (derived or empty)
  - MCP server config written to .matha/config.json
  - Instructions printed for connecting to current IDE

BEHAVIOUR CONTRACT:
  - init must be idempotent (safe to run again, merges not overwrites)
  - init must not fail on empty/new projects
  - init must not fail on existing large codebases
  - init must complete in under 60 seconds for any repo size
```

### Command 2: matha before

```
PURPOSE:
  Run before any AI agent session starts. Executes Gates 01-06.
  Reads the full brain state, surfaces relevant context, checks for
  danger zones, prompts for behaviour contract, generates session brief.

INTERACTIVE PROMPTS:
  1. "What are you about to build or change?"
  2. "Which components will this likely affect?"
  3. "Write the behaviour contract: what must be true after this change?"
     (Opens editor or accepts multiline input)

DERIVED AUTOMATICALLY:
  - Hippocampus danger zone match against stated scope
  - Cortex stability classification of affected components
  - Previous decisions relevant to this area
  - Model tier recommendation based on operation type + history

OUTPUT:
  - .matha/sessions/[timestamp].brief (the session brief)
  - Human-readable summary printed to terminal
  - MCP tool matha_brief() now returns this session's context
  - Dopamine prediction recorded

BEHAVIOUR CONTRACT:
  - before must complete even if no danger zones found
  - before must surface ALL matching danger zones, not just the first
  - before must not block if hippocampus is empty (graceful empty state)
  - before output must be readable as standalone context by any AI agent
  - Contract written during before must be stored in cerebellum
```

### Command 3: matha after

```
PURPOSE:
  Run after every AI agent session ends. Executes Gate 08 — Write Back.
  Captures what was learned, calculates dopamine delta, updates all
  brain components with the session's knowledge.

INTERACTIVE PROMPTS:
  1. "What assumption broke or needed correction?"
  2. "What new business rule or constraint was discovered?"
  3. "What should be remembered as a danger zone?"
  4. "Did the behaviour contract pass? (yes / partial / no)"
  5. "Briefly: what did the session actually change?"

DERIVED AUTOMATICALLY:
  - Files actually touched (from git diff since session start)
  - Test pass rate delta (if test results available)
  - Tokens used (if available from session logs)
  - Dopamine delta from prediction vs actual

OUTPUT:
  - hippocampus/decisions/[timestamp].json (if decision recorded)
  - hippocampus/danger-zones.json (updated if new danger found)
  - cerebellum/violation-log.json (updated if contract violated)
  - cortex/stability.json (updated if blast radius exceeded prediction)
  - dopamine/actuals/[session-id].json (recorded)
  - dopamine/routing-rules.json (updated from delta)
  - Human-readable summary of what was written back

BEHAVIOUR CONTRACT:
  - after must complete even if all prompts are skipped
  - after must not require before to have been run (graceful)
  - after must calculate dopamine delta even with partial data
  - after must append, never overwrite, decision history
```

---

## 9. TECHNICAL STACK

```
RUNTIME:        Node.js 20+ (LTS)
LANGUAGE:       TypeScript (strict mode)
PROTOCOL:       MCP via @modelcontextprotocol/sdk
TRANSPORT:      stdio (for IDE compatibility) + HTTP (for future web use)
STORAGE:        Local JSON files in .matha/ (no database dependency)
GIT ANALYSIS:   simple-git (npm package — for cortex derivation)
CLI:            commander.js (npm package)
INTERACTIVE:    @inquirer/prompts (npm package)
INSTALL:        npm install -g matha-brain
                npx matha init (zero-install first run)
LICENSE:        MIT

DAY 1 TOOL COMPATIBILITY:
  Claude Code   ✓  (MCP native, stdio transport)
  Cursor        ✓  (MCP supported)
  Windsurf      ✓  (MCP supported)
  VS Code       ✓  (MCP supported via extension)
  Any MCP tool  ✓  (protocol-level compatibility)
```

---

## 10. FILE AND MODULE STRUCTURE

```
matha/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── mcp/
│   │   ├── server.ts               # MCP server initialisation
│   │   ├── tools.ts                # All MCP tool definitions
│   │   └── transport.ts            # stdio + HTTP transport setup
│   ├── commands/
│   │   ├── init.ts                 # matha init command
│   │   ├── before.ts               # matha before command
│   │   └── after.ts                # matha after command
│   ├── brain/
│   │   ├── hippocampus.ts          # Intent, rules, decisions, danger zones
│   │   ├── cerebellum.ts           # Behaviour contracts, violation log
│   │   ├── frontal-lobe.ts         # Gate enforcement logic
│   │   ├── cortex.ts               # Knowledge graph, stability map
│   │   └── dopamine.ts             # Prediction, delta, routing rules
│   ├── analysis/
│   │   ├── git-analyser.ts         # Git history → cortex shape derivation
│   │   ├── stability-classifier.ts # Churn → stability classification
│   │   └── contract-matcher.ts     # Context → danger zone matching
│   ├── storage/
│   │   ├── reader.ts               # .matha/ file reads
│   │   ├── writer.ts               # .matha/ file writes (append-safe)
│   │   └── schema-validator.ts     # JSON schema validation
│   └── utils/
│       ├── logger.ts               # Structured logging
│       ├── session.ts              # Session ID generation + management
│       └── prompts.ts              # Interactive prompt definitions
└── tests/
    ├── brain/
    │   ├── hippocampus.test.ts
    │   ├── cerebellum.test.ts
    │   ├── frontal-lobe.test.ts
    │   ├── cortex.test.ts
    │   └── dopamine.test.ts
    ├── commands/
    │   ├── init.test.ts
    │   ├── before.test.ts
    │   └── after.test.ts
    ├── mcp/
    │   └── tools.test.ts
    └── fixtures/
        ├── sample-repo/            # Test repository for integration tests
        └── sample-brain/           # Pre-populated .matha/ for unit tests
```

---

## 11. THE BUILD PHASES (MVP → STANDARD)

### PHASE 0 — PROOF OF CONCEPT (Week 1-2)
*Goal: Does the three-command loop work end-to-end?*

```
Deliverables:
  ✓ matha init works on a new project
  ✓ matha init works on an existing project with git history
  ✓ matha before generates a readable session brief
  ✓ matha after writes back to .matha/ correctly
  ✓ .matha/ directory is well-formed and human-readable
  ✓ MCP server starts and responds to matha_brief() tool call

Success measure:
  Run the PAMM rebuild scenario.
  Does matha before surface the HWM danger zone on day 9?
  Does matha after capture the deposit mid-cycle edge case?

Non-goals for this phase:
  - No git analysis (manual stability declarations only)
  - No dopamine routing (record only, no auto-routing)
  - No cerebellum violation detection (store contracts, no matching)
  - No web UI
  - No cloud sync
```

### PHASE 1 — CORTEX DERIVATION (Week 3-4)
*Goal: The cortex builds itself from git history*

```
Deliverables:
  ✓ git-analyser.ts reads commit history
  ✓ stability-classifier.ts classifies files by churn rate
  ✓ Co-change detection: files that change together are linked
  ✓ Blast radius calculation per component
  ✓ cortex/shape.json auto-populated on matha init
  ✓ cortex/stability.json auto-populated and updated on git commits

Success measure:
  Run on a real project with 3+ months of git history.
  Does the stability map correctly identify frozen vs volatile?
  Does co-change detection surface non-obvious dependencies?
```

### PHASE 2 — CEREBELLUM ACTIVATION (Week 5-6)
*Goal: Danger zones fire before mistakes happen*

```
Deliverables:
  ✓ contract-matcher.ts matches current scope to existing danger zones
  ✓ matha before automatically surfaces matching danger zones
  ✓ Violation detection: if a session's changes touch a frozen component
    without owner gate, a violation is logged
  ✓ cerebellum/violation-log.json populated correctly
  ✓ Behaviour contracts from before sessions are validated post-session

Success measure:
  Plant a known danger zone in .matha/
  Run matha before with a scope that matches it
  Danger zone is surfaced without any manual lookup
```

### PHASE 3 — DOPAMINE LOOP (Week 7-8)
*Goal: The system learns from its own history*

```
Deliverables:
  ✓ Predictions recorded accurately at Gate 06
  ✓ Actuals calculated from git diff + test results at Gate 08
  ✓ Delta calculation: all four signals (behaviour, complexity, cost, knowledge)
  ✓ routing-rules.json updates from accumulated deltas
  ✓ Model tier recommendation improves with each session

Success measure:
  After 10 sessions on the same project, does model routing
  correctly recommend lightweight for renames and capable for
  components with high blast radius and low stability?
```

### PHASE 4 — OPEN SOURCE + COMMUNITY (Week 9-10)
*Goal: Others can use it, contribute to it, build on it*

```
Deliverables:
  ✓ MIT license
  ✓ GitHub public repository
  ✓ README with PAMM story as the proof of concept
  ✓ CONTRIBUTING.md
  ✓ The PAMM rebuild documented as a case study
  ✓ npm publish: npm install -g matha-brain
  ✓ npx matha init zero-install path working

Non-goals for this phase:
  - No hosted service
  - No team sync features
  - No paid tier
```

---

## 12. BEHAVIOUR CONTRACTS (The Cerebellum For matha Itself)

These are the non-negotiable assertions for the matha codebase.
Any change to matha must not violate these.

```
STORAGE CONTRACTS:
  ✓ matha after must NEVER overwrite existing decision entries
  ✓ All writes to .matha/ must be atomic (write to temp, then rename)
  ✓ .matha/ must remain valid JSON after any crash or interruption
  ✓ matha init on existing project must not lose any existing brain data

GATE CONTRACTS:
  ✓ Gate 07 (BUILD) must never open if Gate 05 (CONTRACT) has no output
  ✓ Gate 08 (WRITE BACK) must execute even if session produced no changes
  ✓ All 8 gates must be individually bypassable via --skip-gate flag (for testing)
  ✓ --skip-gate must be logged to session record permanently

MCP CONTRACTS:
  ✓ MCP server must start in under 3 seconds
  ✓ All MCP tools must respond in under 500ms for repos up to 10,000 files
  ✓ MCP server must not crash on malformed tool calls (graceful error)
  ✓ matha_brief() must return useful context even if .matha/ is empty

CLI CONTRACTS:
  ✓ All three commands must work on macOS, Linux, and Windows
  ✓ All three commands must work without any API key or network access
  ✓ matha init must be safe to run on any existing project
  ✓ matha --help must accurately describe all commands and flags
```

---

## 13. DANGER ZONES (Known From Research)

These are the danger zones we discovered during the design of matha.
They are seeded into matha's own .matha/ on day one.

```
DANGER ZONE 001:
  Component: storage/writer.ts
  Pattern: Any write operation that does not use atomic write pattern
  Description: Non-atomic writes to .matha/ will corrupt brain state
               on crash or interruption. ALWAYS write to temp file first,
               then rename to final path.

DANGER ZONE 002:
  Component: frontal-lobe.ts (Gate 05)
  Pattern: Any code path that allows Gate 07 to open without Gate 05 output
  Description: The entire value of matha is the contract-before-code
               sequence. Any bypass of this is a fundamental violation.

DANGER ZONE 003:
  Component: hippocampus.ts (decision log)
  Pattern: Any write that modifies existing decision entries
  Description: Decision history is append-only. Modifying history destroys
               the audit trail that is matha's core value proposition.

DANGER ZONE 004:
  Component: git-analyser.ts
  Pattern: Running git operations on a non-git directory
  Description: Always check for .git presence before any git analysis.
               Graceful fallback to empty cortex if not a git repo.

DANGER ZONE 005:
  Component: mcp/server.ts
  Pattern: Blocking the MCP event loop with synchronous file I/O
  Description: All .matha/ reads and writes must be async.
               Synchronous I/O will block the MCP server for all connected tools.
```

---

## 14. HOW TO BUILD THIS USING AGENTIC IDEs

matha is built with matha. This is the meta-application of our own
framework. Here is the exact workflow for using Cursor, Claude Code, or
any other agentic IDE to build this project.

### Setup For Each AI Session

Before every session building matha:
1. Read this entire document
2. Identify which Phase you are in
3. Identify which component you are building
4. Consult the Behaviour Contracts for that component (Section 12)
5. Consult the Danger Zones (Section 13)
6. Write the specific assertions for your session's task BEFORE coding
7. Build to make those assertions pass

### What To Feed The AI Agent

At the start of each coding session, feed the agent:
- This document (the full roadmap)
- The specific Phase deliverable you are targeting
- The relevant Behaviour Contracts from Section 12
- The relevant Danger Zones from Section 13
- Any existing code in the component you are building

### What NOT To Feed The AI Agent

- Do not ask the agent to "build matha"
- Do not ask the agent to "implement the MCP server"
- Always scope to ONE Phase deliverable per session
- Always give the behaviour contract BEFORE asking for implementation
- Always run matha after at the end of each session (once init exists)

### Session Structure For Each Deliverable

```
1. STATE THE DELIVERABLE
   "We are building: [specific Phase X deliverable from Section 11]"

2. STATE THE CONTRACT
   "This deliverable must satisfy: [assertions from Section 12 that apply]"

3. STATE THE DANGER ZONES
   "Before writing code, note these danger zones: [relevant items from Section 13]"

4. REQUEST IMPLEMENTATION
   "Implement the above, starting with the tests that validate the contract,
   then the implementation that makes the tests pass."

5. VALIDATE
   "Run the tests. Do all behaviour contracts pass?"

6. WRITE BACK
   "What assumption broke? What was learned? Record it in .matha/"
```

### The First Session — Bootstrap Problem

matha cannot initialise itself before it exists. For the first session,
the .matha/ directory is created manually with the minimum seed:

```bash
mkdir .matha
mkdir .matha/hippocampus
mkdir .matha/cerebellum
mkdir .matha/cortex
mkdir .matha/dopamine
mkdir .matha/sessions
```

Then create `.matha/hippocampus/intent.json` manually:

```json
{
  "why": "Give AI agents the project context that currently only lives in a senior engineer's head",
  "core_problem": "Every AI session starts cold — no memory of decisions, rules, or failures",
  "core_insight": "Capture knowledge as a by-product of the work itself, not from humans writing docs"
}
```

And `.matha/hippocampus/rules.json`:

```json
{
  "rules": [
    "Decision history is append-only. Never modify existing entries.",
    "Gate 07 (BUILD) never opens without Gate 05 (CONTRACT) output.",
    "All .matha/ writes must be atomic.",
    "matha never requires network access or an API key."
  ]
}
```

From this point, all subsequent sessions use the three-command workflow once
the CLI commands are implemented.

---

## 15. OPEN QUESTIONS (As Of This Document)

These are unresolved design questions. They must not be answered by the AI
agent. They are surfaced here so they are not accidentally closed by an
implementation decision.

```
OQ-001: Session brief format
  Should the session brief be plain text (human-readable) or structured JSON
  (machine-parseable)? Both has advantages. Decision deferred until Phase 0
  testing reveals which is more useful in practice.

OQ-002: Conflict resolution in decisions
  If two decisions for the same component contradict each other, which takes
  precedence? Current design: most recent. But "confirmed" confidence should
  probably override "uncertain" regardless of timestamp.

OQ-003: Team vs solo projects
  The ownership map assumes individual ownership. For team projects, multiple
  people may own a component. How does matha before surface "you are not
  the owner of this component"? Deferred to Phase 4.

OQ-004: Language-specific test integration
  The Cerebellum stores assertions as descriptions. For Phase 2, should
  matha attempt to parse actual test files (Jest, pytest, etc.) and link
  them to behaviour contracts? Or keep contracts as separate matha
  artifacts that tests are written to validate?

OQ-005: The cold-start problem for new projects
  For a project with no git history and no prior sessions, the Cortex has
  nothing to derive. The Dopamine Loop has no history to learn from.
  What is the minimum useful state matha can provide on a brand new
  project before any history accumulates?
```

---

## 16. SUCCESS DEFINITION

matha v1.0 is complete when:

1. A developer can run `npx matha init` on any project and have a working
   brain in under 5 minutes

2. The PAMM rebuild scenario can be run, and `matha before` surfaces the
   HWM danger zone without any manual configuration

3. After 5 `matha after` sessions on the same project, the session brief
   from `matha before` is materially more useful than a blank slate

4. At least one AI tool (Claude Code or Cursor) can connect to matha via
   MCP and use `matha_brief()` as its first action in a session

5. The .matha/ directory of matha's own repository is a real, populated,
   useful brain — built using the three-command workflow during development

If all five are true, the proof of concept is real. Everything after that
is adoption.

---

*This document is the first stone. Build from here.*
