import {
  normalisePath,
  splitComponent,
  type Contract,
  type DangerZone,
  type DecisionEntry,
} from '@/core/schema.js'
import type { StabilityRecord } from '@/codemap/index.js'

/**
 * The matcher: given what the caller is about to touch (paths + intent),
 * find the stored records that apply. Pure functions over data the engine
 * loads — no filesystem access here.
 *
 * Matching is hierarchical path containment first, keyword overlap second.
 * Substring containment (the 0.1.x approach) is gone: it both over-fired
 * (empty component matched everything as CRITICAL) and under-fired (a zone
 * on "src/payments/" never matched "src/payments/retry.ts").
 *
 * ponytail: linear scan over all records per query — fine to ~10k records,
 * which is orders of magnitude above a real project brain. If that ceiling
 * is ever hit, add a path-prefix index in the engine, not here.
 */

export type MatchType = 'danger_zone' | 'contract' | 'frozen_file' | 'decision_pattern'
export type MatchSeverity = 'critical' | 'warning' | 'info'

export interface MatchResult {
  matchType: MatchType
  severity: MatchSeverity
  title: string
  description: string
  source: string
  component: string
  recommendation: string
  score: number
}

export interface MatchContext {
  scope: string
  intent: string
  filepaths?: string[]
}

export interface BrainData {
  dangerZones: DangerZone[]
  contracts: Contract[]
  stability: StabilityRecord[]
  decisions: DecisionEntry[]
}

// ── PATH SCORING ─────────────────────────────────────────────────────

/**
 * Hierarchical path score between one record path and one query path.
 * exact file/dir 1.0 · one is an ancestor directory of the other 0.8 ·
 * siblings in the same directory 0.4 · otherwise 0.
 */
export function pathPairScore(recordPath: string, queryPath: string): number {
  const r = normalisePath(recordPath)
  const q = normalisePath(queryPath)
  if (!r || !q) return 0
  if (r === q) return 1.0
  if (q.startsWith(r + '/') || r.startsWith(q + '/')) return 0.8
  const rDir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''
  const qDir = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''
  if (rDir && rDir === qDir) return 0.4
  return 0
}

/** Max pairwise score between record paths and query paths. */
export function pathScore(recordPaths: string[], queryPaths: string[]): number {
  let best = 0
  for (const r of recordPaths) {
    for (const q of queryPaths) {
      const s = pathPairScore(r, q)
      if (s > best) best = s
      if (best === 1.0) return best
    }
  }
  return best
}

// ── TEXT MATCHING ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'should', 'never', 'always', 'before', 'after', 'every', 'which',
  'their', 'there', 'where', 'when', 'would', 'could', 'might',
  'using', 'being', 'having', 'about', 'these', 'those', 'while',
])

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 4 && !STOP_WORDS.has(word))
}

/** Whole-word keyword overlap between record text and query text. */
function keywordOverlap(recordText: string, queryText: string): number {
  const recordKeywords = extractKeywords(recordText)
  if (recordKeywords.length === 0) return 0
  const queryWords = new Set(extractKeywords(queryText))
  return recordKeywords.filter((kw) => queryWords.has(kw)).length
}

// ── PER-RECORD MATCHING ──────────────────────────────────────────────

const PATH_MATCH_THRESHOLD = 0.4

interface ComponentMatch {
  matched: boolean
  score: number
}

/**
 * Match a record's component string against the query context.
 * Path-like component parts are matched hierarchically against query
 * filepaths; free-text parts by whole-word keyword overlap against intent.
 * Empty/blank components never match (0.1.x: empty matched EVERYTHING).
 */
function matchComponent(component: string, context: MatchContext): ComponentMatch {
  if (!component || !component.trim()) return { matched: false, score: 0 }

  const { paths: recordPaths, texts: recordTexts } = splitComponent(component)
  const queryPaths = collectQueryPaths(context)

  let score = 0
  if (recordPaths.length > 0 && queryPaths.length > 0) {
    score = pathScore(recordPaths, queryPaths)
  }

  if (score < PATH_MATCH_THRESHOLD) {
    const queryText = `${context.intent} ${context.scope}`
    const textToMatch = recordTexts.join(' ')
    if (textToMatch && keywordOverlap(textToMatch, queryText) > 0) {
      score = Math.max(score, 0.5)
    }
  }

  return { matched: score >= PATH_MATCH_THRESHOLD, score }
}

function collectQueryPaths(context: MatchContext): string[] {
  const fromFilepaths = context.filepaths ?? []
  const fromScope = context.scope
    ? context.scope.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  return [...new Set([...fromFilepaths, ...fromScope].map(normalisePath))].filter(Boolean)
}

// ── MATCHERS PER RECORD TYPE ─────────────────────────────────────────

export function matchDangerZones(context: MatchContext, dangerZones: DangerZone[]): MatchResult[] {
  const results: MatchResult[] = []
  for (const zone of dangerZones) {
    if (zone.status && zone.status !== 'active') continue

    let { matched, score } = matchComponent(zone.component, context)
    // A zone's description can also carry the signal ("never call X during Y")
    if (!matched && zone.description) {
      if (keywordOverlap(zone.description, context.intent) > 0) {
        matched = true
        score = 0.5
      }
    }

    if (matched) {
      results.push({
        matchType: 'danger_zone',
        severity: 'critical',
        title: `Danger Zone: ${zone.component}`,
        description: zone.description || '',
        source: 'danger-zones.json',
        component: zone.component,
        recommendation:
          'Review danger zone before proceeding. Consider matha_record_decision after session.',
        score,
      })
    }
  }
  return results
}

export function matchContracts(context: MatchContext, contracts: Contract[]): MatchResult[] {
  const results: MatchResult[] = []
  for (const contract of contracts) {
    const { matched, score } = matchComponent(contract.component, context)
    if (!matched) continue

    const violations = (contract.assertions || []).filter((a) => a.violation_count > 0)
    const hasViolations = violations.length > 0
    results.push({
      matchType: 'contract',
      severity: hasViolations ? 'critical' : 'info',
      title: `Contract: ${contract.component}`,
      description: hasViolations
        ? `Previously violated ${violations.length} time(s).`
        : 'Contract is currently clean.',
      source: 'contracts',
      component: contract.component,
      recommendation: `Verify all ${(contract.assertions || []).length} contract assertions pass after changes.`,
      score,
    })
  }
  return results
}

export function matchFrozenFiles(
  context: MatchContext,
  stabilityRecords: StabilityRecord[],
): MatchResult[] {
  const results: MatchResult[] = []
  const queryPaths = collectQueryPaths(context)
  if (queryPaths.length === 0) return results

  for (const record of stabilityRecords) {
    if (record.stability !== 'frozen') continue
    const score = pathScore([record.filepath], queryPaths)
    // Frozen warnings need a direct hit (file itself or its directory) —
    // sibling proximity is not enough to cry CRITICAL.
    if (score >= 0.8) {
      results.push({
        matchType: 'frozen_file',
        severity: 'critical',
        title: `Frozen File: ${record.filepath}`,
        description: record.reason || 'No reason provided',
        source: 'cortex/stability.json',
        component: record.filepath,
        recommendation: 'This file is classified FROZEN. Confirm owner approval before modifying.',
        score,
      })
    }
  }
  return results
}

export function matchDecisionPatterns(
  context: MatchContext,
  decisions: DecisionEntry[],
): MatchResult[] {
  const results: MatchResult[] = []
  const active = decisions
    .filter((d) => d.status === 'active')
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  for (const decision of active) {
    if (results.length >= 3) break
    const { matched, score } = matchComponent(decision.component, context)
    if (!matched) continue
    results.push({
      matchType: 'decision_pattern',
      severity: 'warning',
      title: `Prior Decision: ${decision.component}`,
      description: `Previous assumption: ${decision.previous_assumption}. Correction: ${decision.correction}.`,
      source: 'hippocampus/decisions',
      component: decision.component,
      recommendation: 'Be aware of this prior correction when working in this area.',
      score,
    })
  }
  return results
}

// ── COMBINED ─────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<MatchSeverity, number> = { critical: 0, warning: 1, info: 2 }

/** Pure combined matcher: severity first, score second. Deduplicated by type+component. */
export function matchAll(context: MatchContext, data: BrainData): MatchResult[] {
  const allResults = [
    ...matchDangerZones(context, data.dangerZones),
    ...matchContracts(context, data.contracts),
    ...matchFrozenFiles(context, data.stability),
    ...matchDecisionPatterns(context, data.decisions),
  ]

  const seen = new Set<string>()
  const deduplicated: MatchResult[] = []
  for (const result of allResults) {
    const key = `${result.matchType}:${result.component.toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      deduplicated.push(result)
    }
  }

  deduplicated.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.score - a.score,
  )
  return deduplicated
}
