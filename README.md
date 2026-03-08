# MATHA

**The persistent cognitive layer for AI-assisted development.**

---

You gave the AI your entire codebase. You explained the business logic for two hours. You did a Q&A, walked through every edge case, corrected every misunderstanding.

Then you closed the session.

The next day you opened a new one. And it remembered nothing.

Not the HWM calculation that took three sessions to get right. Not the rule about deposit events not triggering profit cycles. Not the assumption that broke everything in V1 and cost you twelve days to fix. Gone. Cold start. Again.

This is not an AI intelligence problem. Every tool — Cursor, Copilot, Claude Code, Windsurf — is stateless by design. They are powerful and amnesiac in equal measure. The larger your project, the more painful that amnesia becomes.

MATHA fixes this.

---

## What MATHA Does

MATHA is a local MCP server that runs alongside your project and gives any AI agent the context that currently only exists inside a senior engineer's head.

It captures three things that no markdown file can hold:

**Intent** — why the project exists, what the non-negotiable rules are, what it explicitly does not do. Not features. The reasoning behind them.

**Decisions** — every assumption that broke, every correction that was made, every "no that's wrong" moment that cost you days. Captured automatically from the work itself, not from humans writing docs after the fact.

**Behaviour contracts** — what the system must do, written before code is written. Machine-verifiable. Validated after every session. Violations recorded and surfaced automatically next time.

Every session writes back what it learned. Every session starts warmer than the last. The brain stays on.

---

## How It Works

Three commands. That's the entire interface.

```bash
# Once per project — seeds the brain from your project's intent and git history
matha init

# Before every AI session — surfaces what the brain knows, fires warnings, 
# writes behaviour contract before a single line of code is written
matha before

# After every AI session — captures what was learned, records violations,
# updates the brain so the next session starts with full context
matha after
```

The session brief produced by `matha before` is copy-pasteable directly into any AI agent. It tells the agent what it needs to know before it touches anything — danger zones, prior decisions, frozen files, behaviour contract.

The write-back from `matha after` means that correction never has to be made twice.

---

## Installation

```bash
npm install -g @10kdevs/matha
```

Zero-install first run:
```bash
npx @10kdevs/matha init
```

Requires Node.js 20+. No API key. No cloud dependency. All data stays in your repository.

---

## Connecting To Your IDE

After `matha init`, connect MATHA to your IDE via MCP.

The init command writes `.matha/mcp-config.json` with the exact config for your machine. Add it to your IDE's MCP configuration.

**Claude Code:**
```bash
# .matha/mcp-config.json contains the correct config
# Add to your Claude Code MCP settings
```

**Cursor:**
```json
{
  "mcpServers": {
    "matha": {
      "command": "node",
      "args": ["/path/to/your/project/node_modules/.bin/matha", "serve"]
    }
  }
}
```

Once connected, your AI agent can call `matha_brief()` as its first action in any session — receiving the full project context before writing a line.

---

## The Eight Gates

`matha before` runs eight structured gates before allowing the AI to build. Not as a prompt. As enforced infrastructure.

```
GATE 01  UNDERSTAND     What is the WHY of this change?
GATE 02  BOUND          What are the non-negotiable rules?
GATE 03  ORIENT         What exists? What is stable, frozen, volatile?
GATE 04  SURFACE DANGER Any prior failures in this area?
GATE 05  CONTRACT       What must be true after? Written before code.
GATE 06  COST CHECK     What model tier? What token budget?
GATE 07  BUILD          AI is now allowed to generate code.
GATE 08  WRITE BACK     What was learned? Captured. Never lost.
```

Gate 07 does not open until Gates 01 through 05 are complete.

---

## The Brain

MATHA's knowledge lives in `.matha/` in your repository. Committed to version control. Owned by your team. Never sent anywhere.

```
.matha/
├── hippocampus/        intent, rules, decisions, danger zones
├── cerebellum/         behaviour contracts, violation log  
├── cortex/             stability map, co-change graph, boundaries
├── dopamine/           session history, routing rules, deltas
└── sessions/           session briefs
```

The cortex builds itself from git history. Files that change together are linked. Files with low churn and high connectivity are classified frozen — AI agents are warned before touching them.

The dopamine loop learns from every session. If business logic changes in your project consistently burn three times the predicted token budget, MATHA adjusts its recommendation automatically. It tells you why.

---

## MCP Tools

AI agents connected via MCP have access to:

```
matha_brief(scope?, directory?)     Full session context
matha_get_rules()                   Non-negotiable business rules
matha_get_danger_zones(context?)    Known failure patterns
matha_get_decisions(component?)     Decision history
matha_get_stability(files[])        Stability classification per file
matha_match(scope, intent)          Full cerebellum match — what does
                                    the brain know about this operation?
matha_record_decision(...)          Write a decision back to the brain
matha_record_danger(...)            Flag a new danger zone
matha_record_contract(...)          Store a behaviour contract
matha_refresh_cortex()              Rebuild from git history
matha_get_routing(operationType?)   Learned model routing rules
```

---

## Initialising From An Existing Document

If your project already has a BRD, spec, or requirements document:

```bash
matha init --from requirements.md
```

MATHA parses business rules, boundaries, and intent from the document and pre-fills the init prompts. You review and confirm. Nothing is written without your sign-off.

---

## What MATHA Is Not

MATHA does not generate code.

MATHA does not replace your IDE, your AI model, or your version control.

MATHA does not require a specific model, a specific IDE, or a specific language. If your tool supports MCP, it connects to MATHA on day one.

MATHA does not send your data anywhere. The brain lives in your repository.

---

## The Real Problem It Solves

There is a moment every developer who uses AI tools eventually hits.

The project is large enough that you cannot hold all of it in your head. The AI cannot hold all of it in its context window. You find yourself explaining the same decision three times across three sessions. You find a bug and you are not confident which part of the codebase is responsible. You realise you have forgotten the core logic you wrote four weeks ago.

At that moment, the AI is not the problem. The absence of accumulated understanding is the problem.

MATHA is the accumulated understanding.

It is what the senior engineer carries in their head after three years on a project — the why behind every decision, the scars from every production incident, the rules that cannot be broken and the code that cannot be touched without knowing why it works the way it does.

That knowledge survives sessions. It survives team changes. It survives the moment you come back to a project six months after you last touched it.

The code gets better. The context never resets. The brain stays on.

---

## Case Study

[How MATHA would have saved 12 days on a real PAMM trading platform →](docs/pamm-case-study.md)

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

MIT — owned by nobody, usable by everyone.

---

*Built because the problem was real.*