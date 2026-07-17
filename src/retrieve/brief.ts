import type { Engine, Diagnostics } from '@/core/engine.js'
import type { DecisionEntry } from '@/core/schema.js'
import { matchAll, type MatchContext, type MatchResult } from '@/retrieve/match.js'

/**
 * Brief assembly — the single implementation behind both `matha before`
 * (CLI) and `matha_brief` (MCP). Profile-style: static project knowledge
 * (why + rules) + recent decisions + scope-matched results.
 *
 * ponytail: fixed item caps (20 matches / 5 decisions) instead of token
 * counting — Phase 2 replaces caps with a real token budget per the
 * target-architecture doc.
 */

const MAX_MATCHES = 20
const MAX_RECENT_DECISIONS = 5

export interface Brief {
  why: string
  rules: string[]
  recentDecisions: Array<{
    component: string
    previous_assumption: string
    correction: string
    timestamp: string
  }>
  matchResults: MatchResult[]
  hasCritical: boolean
  truncated: boolean
  diagnostics: Diagnostics
}

export interface BriefOptions {
  scope?: string
  intent?: string
  filepaths?: string[]
}

export async function assembleBrief(engine: Engine, opts: BriefOptions = {}): Promise<Brief> {
  const [intent, rules, data] = await Promise.all([
    engine.getIntent(),
    engine.getRules(),
    engine.loadBrain(),
  ])

  const scope = opts.scope ?? ''
  const context: MatchContext = {
    scope,
    intent: opts.intent ?? (scope ? `working on ${scope}` : 'reviewing project context'),
    filepaths: opts.filepaths ?? [],
  }

  const allMatches = scope || (opts.filepaths?.length ?? 0) > 0 ? matchAll(context, data) : []
  const matchResults = allMatches.slice(0, MAX_MATCHES)

  const recentDecisions = data.decisions
    .filter((d: DecisionEntry) => d.status === 'active')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_RECENT_DECISIONS)
    .map((d) => ({
      component: d.component,
      previous_assumption: d.previous_assumption,
      correction: d.correction,
      timestamp: d.timestamp,
    }))

  return {
    why: intent?.why ?? '',
    rules,
    recentDecisions,
    matchResults,
    hasCritical: matchResults.some((r) => r.severity === 'critical'),
    truncated: allMatches.length > MAX_MATCHES,
    diagnostics: {
      brainDir: engine.mathaDir,
      recordsConsidered:
        data.dangerZones.length + data.contracts.length + data.stability.length + data.decisions.length,
    },
  }
}
