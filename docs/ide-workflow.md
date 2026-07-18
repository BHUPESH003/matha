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

Connect MATHA as an MCP server. Your AI agent calls `matha_brief()` automatically as its first action and receives full project context before writing a line. When it discovers something new — a broken assumption, a new danger zone — it calls `matha_record()` before the session ends.

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
call matha_record() before the session ends.

If you touch a file classified as frozen or stable, explain why before 
proceeding.
```

This is the simplest possible implementation of persistent AI context — no new infrastructure, no automation, no hooks. The MCP tools exist. This prompt activates them. Paste it. The AI does the rest.

This is deliberately low-friction. It works with any MCP-compatible agent, today, without installing anything beyond MATHA itself.

---

## What Each MCP Tool Does

| Tool | When to call it | What it returns |
|------|-----------------|-----------------|
| `matha_brief(scope?, intent?, filepaths?)` | Start of every session | Token-budgeted context: why, rules, recent decisions, and scored matches for the scope |
| `matha_match(scope, intent, filepaths?)` | Before modifying files | Scored matches — danger zones, contracts, frozen files, prior decisions — with `hasCritical` |
| `matha_record(type, ...)` | When the session learns something durable | The one write tool. New knowledge: `type=decision` (broken assumption + correction), `type=danger` (non-obvious failure pattern), `type=contract` (assertions that must stay true). Lifecycle: `type=violation` (an assertion was observed broken), `type=supersede` (replace a decision that proved wrong), `type=retire` (a record no longer applies, with reason) |
| `matha_refresh()` | After significant commits | Re-runs git analysis and rebuilds the stability map and co-change graph (also happens automatically on read when HEAD moves) |

Agent writes are capped at `probable` confidence — `confirmed` is reserved for humans (`matha after`, `matha review`). Declared boundaries (`matha boundary add`) are CLI-only and always CRITICAL on a path match.

IDEs that support MCP **prompts** can also pull `matha_context(scope?, intent?)` — the brief plus the standing record-what-you-learn instruction, injected as a single message.

---

## Verifying The Connection

To confirm MATHA is connected and responding, call the simplest read tool from your agent:

```
Call matha_brief()
```

**If it returns rules and a why** — MATHA is connected. They were captured at `matha init`.

**If it returns an error naming tried paths** — MATHA is connected but no brain was found. Run `matha init` in your project root, or check `--project` in your MCP config. `matha doctor` shows exactly which brain would be served.

**If it returns an error about the path** — the path in your MCP config is wrong. Check that the path in `args` is absolute, not relative. The correct path is in `.matha/mcp-config.json`.

**If the tool does not appear at all** — the MCP server is not running or not registered. Confirm that `matha serve` starts without error from your project root, then check that the MCP config file is in the location your IDE expects.
