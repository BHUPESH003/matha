import { performance } from 'perf_hooks'
import { Engine } from '../../src/core/engine.js'
import { assembleBrief, BRIEF_TOKEN_BUDGET } from '../../src/retrieve/brief.js'
import type { MatchContext, MatchResult } from '../../src/retrieve/match.js'
import type { GoldenQuery } from './fixture.js'

/** Pluggable so scripts/eval-report.ts can run the same queries through a
 * comparison matcher (e.g. a naive baseline) and reuse all the metric math
 * below — only the match step differs between "current" and "baseline". */
export type Matcher = (engine: Engine, context: MatchContext) => Promise<{ results: MatchResult[] }>

/**
 * Golden-set runner (target-architecture §3.1). Metrics per run:
 *   recall@5        — of the ids a query expects, how many landed in the top 5
 *   precision@5     — of the top 5 returned, how many were expected
 *   falseCriticalRate — CRITICAL results not whitelisted by the query, per query
 *   briefTokenMax   — worst-case brief tokenEstimate (must stay ≤ budget)
 *   p95LatencyMs    — warm match latency (the in-memory index promise)
 */

export interface QueryOutcome {
  name: string
  top5: string[]
  expected: string[]
  missed: string[]
  falseCriticals: string[]
  latencyMs: number
  briefTokens: number
}

export interface EvalMetrics {
  recallAt5: number
  precisionAt5: number
  falseCriticalRate: number
  briefTokenMax: number
  briefBudget: number
  p95LatencyMs: number
  outcomes: QueryOutcome[]
}

export async function runGoldenSet(
  engine: Engine,
  queries: GoldenQuery[],
  now: number,
  matcher: Matcher = (e, c) => e.match(c),
): Promise<EvalMetrics> {
  // Warm the engine cache once — production is a long-lived server process,
  // so warm latency is the number that matters.
  await engine.loadBrain()

  const outcomes: QueryOutcome[] = []
  for (const q of queries) {
    const context = { scope: q.scope, intent: q.intent, filepaths: q.filepaths ?? [], now }
    const t0 = performance.now()
    const { results } = await matcher(engine, context)
    const latencyMs = performance.now() - t0

    const top5 = results.slice(0, 5).map((r) => r.recordId)
    const missed = q.expect.filter((id) => !top5.includes(id))
    const falseCriticals = results
      .filter((r) => r.severity === 'critical' && !q.expectCritical.includes(r.recordId))
      .map((r) => r.recordId)

    const brief = await assembleBrief(engine, {
      scope: q.scope,
      intent: q.intent,
      filepaths: q.filepaths,
      now,
    })

    outcomes.push({
      name: q.name,
      top5,
      expected: q.expect,
      missed,
      falseCriticals,
      latencyMs,
      briefTokens: brief.tokenEstimate,
    })
  }

  const scored = outcomes.filter((o) => o.expected.length > 0)
  const recallAt5 =
    scored.reduce((sum, o) => sum + (o.expected.length - o.missed.length) / o.expected.length, 0) /
    Math.max(1, scored.length)
  const withResults = scored.filter((o) => o.top5.length > 0)
  const precisionAt5 =
    withResults.reduce(
      (sum, o) => sum + o.top5.filter((id) => o.expected.includes(id)).length / o.top5.length,
      0,
    ) / Math.max(1, withResults.length)
  const falseCriticalRate =
    outcomes.reduce((sum, o) => sum + o.falseCriticals.length, 0) / Math.max(1, outcomes.length)

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b)
  const p95LatencyMs = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]

  return {
    recallAt5,
    precisionAt5,
    falseCriticalRate,
    briefTokenMax: Math.max(...outcomes.map((o) => o.briefTokens)),
    briefBudget: BRIEF_TOKEN_BUDGET,
    p95LatencyMs,
    outcomes,
  }
}

/** One-line-per-failure report, printed when a threshold is missed. */
export function formatFailures(metrics: EvalMetrics): string {
  const lines: string[] = []
  for (const o of metrics.outcomes) {
    if (o.missed.length > 0) {
      lines.push(`MISS  ${o.name}: missing [${o.missed.join(', ')}], top5=[${o.top5.join(', ')}]`)
    }
    if (o.falseCriticals.length > 0) {
      lines.push(`CRIT  ${o.name}: false criticals [${o.falseCriticals.join(', ')}]`)
    }
  }
  lines.push(
    `recall@5=${metrics.recallAt5.toFixed(3)} precision@5=${metrics.precisionAt5.toFixed(3)} ` +
      `falseCritical=${metrics.falseCriticalRate.toFixed(3)} briefTokenMax=${metrics.briefTokenMax}/${metrics.briefBudget} ` +
      `p95=${metrics.p95LatencyMs.toFixed(2)}ms`,
  )
  return lines.join('\n')
}
