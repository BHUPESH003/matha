import type { Engine, Diagnostics } from '@/core/engine.js'
import type { DecisionEntry } from '@/core/schema.js'
import { matchAll, type MatchContext, type MatchResult } from '@/retrieve/match.js'

/**
 * Brief assembly — the single implementation behind both `matha before`
 * (CLI) and `matha_brief` (MCP). Profile-style, under one hard token budget:
 *
 *   static  — why + rules: always included, the stable profile core
 *   dynamic — most recent active decisions, added while budget remains
 *   matched — scored results (severity-then-score order, so criticals are
 *             never the ones truncated), added while budget remains,
 *             deduped against dynamic (a decision already shown recently
 *             is not repeated as a match)
 *
 * Tokens are estimated at ~4 chars/token over the serialized item — cheap,
 * approximate, and consistent, which is all a budget needs. The estimate is
 * returned so "context got cheaper" is measurable by the eval harness.
 */

export const BRIEF_TOKEN_BUDGET = 1500
const MAX_RECENT_DECISIONS = 5

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4)
}

export interface BriefDecision {
  id: string
  component: string
  previous_assumption: string
  correction: string
  timestamp: string
}

export interface Brief {
  why: string
  rules: string[]
  recentDecisions: BriefDecision[]
  matchResults: MatchResult[]
  hasCritical: boolean
  truncated: boolean
  tokenEstimate: number
  diagnostics: Diagnostics
}

export interface BriefOptions {
  scope?: string
  intent?: string
  filepaths?: string[]
  /** Token budget override — default BRIEF_TOKEN_BUDGET. */
  budget?: number
  /** Clock for recency decay — injectable for tests/eval. */
  now?: number
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
    now: opts.now,
  }

  const budget = opts.budget ?? BRIEF_TOKEN_BUDGET
  const why = intent?.why ?? ''

  // static — always in, spends budget first
  let spent = estimateTokens({ why, rules })
  let truncated = false

  // dynamic — recent decisions while budget remains
  const recentDecisions: BriefDecision[] = []
  const recentCandidates = data.decisions
    .filter((d: DecisionEntry) => d.status === 'active')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  for (const d of recentCandidates) {
    if (recentDecisions.length >= MAX_RECENT_DECISIONS) break
    const entry: BriefDecision = {
      id: d.id,
      component: d.component,
      previous_assumption: d.previous_assumption,
      correction: d.correction,
      timestamp: d.timestamp,
    }
    const cost = estimateTokens(entry)
    if (spent + cost > budget) {
      truncated = true
      break
    }
    spent += cost
    recentDecisions.push(entry)
  }

  // matched — scored results while budget remains, deduped against dynamic
  const allMatches =
    scope || (opts.filepaths?.length ?? 0) > 0 ? matchAll(context, data) : []
  const shownDecisionIds = new Set(recentDecisions.map((d) => d.id))
  const matchResults: MatchResult[] = []
  for (const m of allMatches) {
    if (m.matchType === 'decision_pattern' && shownDecisionIds.has(m.recordId)) continue
    const cost = estimateTokens(m)
    if (spent + cost > budget) {
      truncated = true
      break
    }
    spent += cost
    matchResults.push(m)
  }

  return {
    why,
    rules,
    recentDecisions,
    matchResults,
    // computed pre-truncation: a critical the budget cut still raises the flag
    hasCritical: allMatches.some((r) => r.severity === 'critical'),
    truncated,
    tokenEstimate: spent,
    diagnostics: {
      brainDir: engine.mathaDir,
      recordsConsidered:
        data.dangerZones.length + data.contracts.length + data.stability.length + data.decisions.length,
    },
  }
}
