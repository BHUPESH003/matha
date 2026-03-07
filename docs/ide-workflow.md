# Using MATHA With Your AI Agent

---

## The Two Ways To Use MATHA

MATHA works at two levels. You can use either or both.

---

### Way 1 — CLI Workflow (manual, full control)

Run `matha before` before opening your IDE. Copy the session brief it produces into your AI agent as the first message. Do the work. Run `matha after` when done.

```bash
matha before
# Gates 01–06 run. Brief is printed to terminal.
# Copy the brief. Paste it into your AI agent.

# ... do the work ...

matha after
# Write-back gates run. Brain is updated.
```

The brief is plain text designed to copy-paste directly into any agent — Claude, ChatGPT, a Cursor conversation, anything. No IDE integration required.

**Best for:** Complex sessions. Architecture changes. Anything touching components marked frozen or stable. Situations where you want explicit control over what context the AI receives before starting.

---

### Way 2 — MCP Workflow (automatic, always-on)

Connect MATHA as an MCP server. Your AI agent calls `matha_brief()` automatically as its first action and receives full project context before writing a line. When it discovers something new — a broken assumption, a new danger zone — it calls `matha_record_decision()` before the session ends.

**Best for:** Day-to-day development. Smaller, frequent changes. Teams where enforcing manual CLI discipline across every developer is impractical.

---

## Connecting to Claude Code

After running `matha init`, the file `.matha/mcp-config.json` contains the correct configuration for your machine. Add its contents to your Claude Code MCP settings.

The config will look like:

```json
{
  "mcpServers": {
    "matha": {
      "command": "node",
      "args": ["/absolute/path/to/your/project/node_modules/.bin/matha", "serve"],
      "env": {}
    }
  }
}
```

Use the absolute path from `.matha/mcp-config.json` — the path is generated from your actual project root at init time. Do not use relative paths.

To add to Claude Code's configuration, open Claude Code settings and navigate to the MCP Servers section. Paste or merge the config from `.matha/mcp-config.json`.

---

## Connecting to Cursor

In Cursor, MCP server configuration lives in `.cursor/mcp.json` in your project root, or in the global Cursor settings.

```json
{
  "mcpServers": {
    "matha": {
      "command": "node",
      "args": ["/absolute/path/to/your/project/node_modules/.bin/matha", "serve"]
    }
  }
}
```

Again, use the absolute path from `.matha/mcp-config.json`. After saving, restart Cursor or reload the MCP servers from the settings panel. The MATHA tools should appear in the available tools list.

---

## Connecting to Windsurf

In Windsurf, MCP configuration is managed from the Cascade panel. Open Cascade → Settings → MCP Servers → Add Server.

Configure:
- **Command:** `node`
- **Arguments:** `/absolute/path/to/your/project/node_modules/.bin/matha serve`

Or add directly to your Windsurf MCP config file:

```json
{
  "mcpServers": {
    "matha": {
      "command": "node",
      "args": ["/absolute/path/to/project/node_modules/.bin/matha", "serve"]
    }
  }
}
```

---

## The Recommended Agent Prompt Prefix

When starting any session — whether via CLI brief or MCP — paste this before your actual prompt:

```
Before writing any code, call matha_brief() to retrieve the project 
context. Review all danger zones, prior decisions, and the behaviour 
contract before proceeding.

If you discover a new business rule or a prior assumption was wrong, 
call matha_record_decision() before the session ends.

If you touch a file classified as frozen or stable, explain why before 
proceeding.
```

This is the simplest possible implementation of persistent AI context — no new infrastructure, no automation, no hooks. The MCP tools exist. This prompt activates them. Paste it. The AI does the rest.

This is deliberately low-friction. It works with any MCP-compatible agent, today, without installing anything beyond MATHA itself.

---

## What Each MCP Tool Does

| Tool | When to call it | What it returns |
|------|-----------------|-----------------|
| `matha_brief(scope?, directory?)` | Start of every session | Full context: rules, danger zones, decisions, stability, behaviour contract, match results |
| `matha_get_rules()` | When you need business rules only | Array of non-negotiable rules from `matha init` |
| `matha_get_danger_zones(context?)` | Before touching a specific area | Known failure patterns, filtered by context string if provided |
| `matha_get_decisions(component?, limit?)` | Before modifying a component | Decision history — what assumptions broke here and what the corrections were |
| `matha_get_stability(files[])` | Before modifying specific files | Stability classification per file: frozen, stable, volatile, or disposable |
| `matha_match(scope, intent, operationType?)` | Before starting any write operation | Full cerebellum match — contracts, danger zones, and decisions relevant to this exact operation |
| `matha_record_decision(component, prevAssumption, correction)` | When you discover a prior assumption was wrong | Writes the correction to the brain so the next session inherits it |
| `matha_record_danger(component, description)` | When you find a new failure pattern | Writes a danger zone so future sessions are warned automatically |
| `matha_record_contract(component, assertions[])` | When establishing a behaviour contract for a component | Stores assertions that will be matched against future operations on this component |
| `matha_refresh_cortex()` | After significant commits | Re-runs git analysis and rebuilds the stability map from current history |
| `matha_get_routing(operationType?)` | When planning a session's model and token budget | Returns learned routing recommendation, or full dopamine analysis if no type specified |

---

## Verifying The Connection

To confirm MATHA is connected and responding, call the simplest read tool from your agent:

```
Call matha_get_rules()
```

**If it returns rules** — MATHA is connected. The rules shown were captured at `matha init`.

**If it returns an empty array** — MATHA is connected but the project has not been initialised. Run `matha init` in your project root first.

**If it returns an error about the path** — the path in your MCP config is wrong. Check that the path in `args` is absolute, not relative. The correct path is in `.matha/mcp-config.json`.

**If the tool does not appear at all** — the MCP server is not running or not registered. Confirm that `matha serve` starts without error from your project root, then check that the MCP config file is in the location your IDE expects.
