# matha — agent instructions

At the start of every conversation, call matha_brief() before writing any
code. Review all rules, danger zones, and prior decisions. Flag any
hasCritical:true results before proceeding. After completing work, call
matha_record() for any assumption that changed during the session.

The matha MCP server in .mcp.json runs from `dist/` — run `npm run build`
after pulling if tools behave unexpectedly (stale build).

Project rules that retrieval also serves (kept in .matha/, source of truth):

- Decision history is append-only; never modify existing entries.
- All .matha/ writes must be atomic: temp+rename for single-writer whole-file
  replacement; O_APPEND (raw append, no read-modify-write) for the
  decisions/ log specifically, since it's the one record type multiple
  team members' agents write to concurrently and temp+rename can silently
  drop a concurrent writer's update.
- matha never requires network access or an API key.
- Scoring constants in src/retrieve/match.ts are tuned against
  tests/eval/ — change them only with the golden set updated.
