import {
  normalisePath,
  splitComponent,
  type Confidence,
  type Contract,
  type DangerZone,
  type DecisionEntry,
} from '@/core/schema.js'
import type { StabilityRecord } from '@/codemap/index.js'
import type { CoChangeRecord } from '@/codemap/git-analyser.js'

/**
 * The matcher: given what the caller is about to touch (paths + intent),
 * find the stored records that apply. Pure functions over data the engine
 * loads — no filesystem access here.
 *
 * Scoring pipeline (target-architecture §2): every active record gets
 *   score = S × L × C × R
 *   S — structural path score (hierarchical containment, then co-change
 *       expansion via the codemap graph, floor 0.1 for text-only records)
 *   L — lexical score (BM25 of record text vs intent, mapped to [0.5, 1.5)
 *       so a path hit survives an intent with no word overlap)
 *   C — confidence weight (confirmed 1.0 / probable 0.7 / uncertain 0.4)
 *   R — recency (decisions decay, half-weight ≈ 180 days, floored; rules,
 *       zones and contracts don't decay)
 * Records below MIN_SCORE are dropped. Severity is a presentation attribute
 * gated by S: a danger zone or frozen file is CRITICAL only on a direct
 * structural hit (S ≥ 0.8) — a lexical-only match can never cry CRITICAL.
 *
 * ponytail: linear scan + per-call BM25 stats over all records — fine to
 * ~10k records, orders of magnitude above a real project brain. If that
 * ceiling is ever hit, add a path-prefix index in the engine, not here.
 * Constants below are tuned against tests/eval golden set — change them
 * there, with data, not here by taste.
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
  /** Stable record id — danger zone / decision id, contract component, frozen filepath. */
  recordId: string
  /** Final S×L×C×R score, for ranking and eval. */
  score: number
}

export interface MatchContext {
  scope: string
  intent: string
  filepaths?: string[]
  /** Clock for recency decay — injectable for tests/eval. Defaults to Date.now(). */
  now?: number
}

export interface BrainData {
  dangerZones: DangerZone[]
  contracts: Contract[]
  stability: StabilityRecord[]
  decisions: DecisionEntry[]
  coChanges: CoChangeRecord[]
}

// ── TUNING CONSTANTS (validated by tests/eval golden set) ────────────

const MIN_SCORE = 0.08
const CRITICAL_STRUCTURAL = 0.8
const TEXT_ONLY_STRUCTURAL = 0.1
const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  confirmed: 1.0,
  probable: 0.7,
  uncertain: 0.4,
}
const DECAY_HALF_LIFE_DAYS = 180
const DECAY_FLOOR = 0.3

// ── STRUCTURAL PATH SCORING ──────────────────────────────────────────

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

/**
 * Co-change expansion: a record with no path overlap still gets structural
 * signal if its path co-changes with a query file in the codemap graph.
 * Capped at 0.5 — co-change proximity is never a direct hit.
 */
function coChangeScore(
  recordPaths: string[],
  queryPaths: string[],
  coChanges: CoChangeRecord[],
): number {
  let best = 0
  for (const pair of coChanges) {
    const linked =
      (pathScore(recordPaths, [pair.fileA]) >= CRITICAL_STRUCTURAL &&
        pathScore(queryPaths, [pair.fileB]) >= CRITICAL_STRUCTURAL) ||
      (pathScore(recordPaths, [pair.fileB]) >= CRITICAL_STRUCTURAL &&
        pathScore(queryPaths, [pair.fileA]) >= CRITICAL_STRUCTURAL)
    if (linked) {
      best = Math.max(best, Math.min(0.5, 0.2 + 0.05 * pair.coChangeCount))
    }
  }
  return best
}

function structuralScore(
  recordPaths: string[],
  queryPaths: string[],
  coChanges: CoChangeRecord[],
): number {
  if (recordPaths.length === 0 || queryPaths.length === 0) return TEXT_ONLY_STRUCTURAL
  const direct = pathScore(recordPaths, queryPaths)
  if (direct > 0) return direct
  const viaCoChange = coChangeScore(recordPaths, queryPaths, coChanges)
  return Math.max(viaCoChange, TEXT_ONLY_STRUCTURAL)
}

// ── LEXICAL SCORING (BM25, no dependency) ────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'are', 'was',
  'should', 'never', 'always', 'before', 'after', 'every', 'which',
  'their', 'there', 'where', 'when', 'would', 'could', 'might',
  'using', 'being', 'having', 'about', 'these', 'those', 'while',
])

/** Lowercase, strip punctuation, drop stop words, naive plural stemming. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
}

const BM25_K1 = 1.5
const BM25_B = 0.75
// IDF smoothing: pretend the corpus has 10 extra empty documents. Without
// this, a young brain (1–3 records) gives every term a near-zero IDF and
// lexical matching dies exactly when matha is newly adopted.
const BM25_VIRTUAL_DOCS = 10

/** BM25 scorer over a fixed corpus of tokenized documents. */
function makeBm25(docs: string[][]): (queryTokens: string[], docIndex: number) => number {
  const n = docs.length + BM25_VIRTUAL_DOCS
  const avgLen =
    docs.length === 0 ? 0 : docs.reduce((sum, d) => sum + d.length, 0) / docs.length
  const docFreq = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }

  return (queryTokens, docIndex) => {
    const doc = docs[docIndex]
    if (!doc || doc.length === 0 || avgLen === 0) return 0
    const termFreq = new Map<string, number>()
    for (const t of doc) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)

    let score = 0
    for (const term of new Set(queryTokens)) {
      const tf = termFreq.get(term)
      if (!tf) continue
      const df = docFreq.get(term) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLen))
    }
    return score
  }
}

/** Map raw BM25 to a saturating multiplier in [0.5, 1.5). */
function lexicalMultiplier(bm25: number): number {
  return 0.5 + bm25 / (bm25 + 2)
}

// ── RECENCY ──────────────────────────────────────────────────────────

function recencyWeight(timestamp: string, now: number): number {
  const ageMs = now - Date.parse(timestamp)
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  const halfLives = ageMs / (DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000)
  return Math.max(DECAY_FLOOR, Math.pow(0.5, halfLives))
}

// ── CANDIDATES (one uniform shape per record type) ───────────────────

interface Candidate {
  matchType: MatchType
  recordId: string
  component: string
  paths: string[]
  text: string
  title: string
  description: string
  source: string
  recommendation: string
  confidence?: Confidence
  timestamp?: string
  /** Minimum structural score for this candidate to appear at all. */
  minStructural?: number
  severityFor: (structural: number) => MatchSeverity
}

function buildCandidates(data: BrainData): Candidate[] {
  const candidates: Candidate[] = []

  for (const zone of data.dangerZones) {
    if (zone.status && zone.status !== 'active') continue
    const { paths, texts } = splitComponent(zone.component)
    candidates.push({
      matchType: 'danger_zone',
      recordId: zone.id,
      component: zone.component,
      paths,
      text: [...texts, zone.pattern, zone.description].filter(Boolean).join(' '),
      title: `Danger Zone: ${zone.component}`,
      description: zone.description || '',
      source: 'danger-zones.json',
      recommendation:
        'Review danger zone before proceeding. Consider matha_record after session.',
      confidence: zone.confidence,
      severityFor: (s) => (s >= CRITICAL_STRUCTURAL ? 'critical' : 'warning'),
    })
  }

  for (const contract of data.contracts) {
    const { paths, texts } = splitComponent(contract.component)
    const assertions = contract.assertions || []
    const violations = assertions.filter((a) => a.violation_count > 0)
    candidates.push({
      matchType: 'contract',
      recordId: `contract:${contract.component}`,
      component: contract.component,
      paths,
      text: [...texts, ...assertions.map((a) => a.description)].join(' '),
      title: `Contract: ${contract.component}`,
      description:
        violations.length > 0
          ? `Previously violated ${violations.length} time(s).`
          : 'Contract is currently clean.',
      source: 'contracts',
      recommendation: `Verify all ${assertions.length} contract assertions pass after changes.`,
      severityFor: (s) =>
        violations.length > 0 ? (s >= CRITICAL_STRUCTURAL ? 'critical' : 'warning') : 'info',
    })
  }

  for (const record of data.stability) {
    if (record.stability !== 'frozen') continue
    candidates.push({
      matchType: 'frozen_file',
      recordId: `frozen:${record.filepath}`,
      component: record.filepath,
      paths: [normalisePath(record.filepath)],
      text: record.reason || '',
      title: `Frozen File: ${record.filepath}`,
      description: record.reason || 'No reason provided',
      source: 'cortex/stability.json',
      recommendation: 'This file is classified FROZEN. Confirm owner approval before modifying.',
      // A frozen warning needs a direct hit — proximity is not enough to cry CRITICAL.
      minStructural: CRITICAL_STRUCTURAL,
      severityFor: () => 'critical',
    })
  }

  for (const decision of data.decisions) {
    if (decision.status !== 'active') continue
    const { paths, texts } = splitComponent(decision.component)
    candidates.push({
      matchType: 'decision_pattern',
      recordId: decision.id,
      component: decision.component,
      paths,
      text: [...texts, decision.previous_assumption, decision.correction].join(' '),
      title: `Prior Decision: ${decision.component}`,
      description: `Previous assumption: ${decision.previous_assumption}. Correction: ${decision.correction}.`,
      source: 'hippocampus/decisions',
      recommendation: 'Be aware of this prior correction when working in this area.',
      confidence: decision.confidence,
      timestamp: decision.timestamp,
      severityFor: () => 'warning',
    })
  }

  return candidates
}

function collectQueryPaths(context: MatchContext): string[] {
  const fromFilepaths = context.filepaths ?? []
  const fromScope = context.scope
    ? context.scope.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  return [...new Set([...fromFilepaths, ...fromScope].map(normalisePath))].filter(Boolean)
}

// ── COMBINED ─────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<MatchSeverity, number> = { critical: 0, warning: 1, info: 2 }

/**
 * Pure combined matcher: score every record, drop below-threshold, dedup
 * by type+component, sort severity first then score. Ordering doubles as
 * budget-inclusion order in brief assembly, so criticals are never the
 * ones truncated away.
 */
export function matchAll(context: MatchContext, data: BrainData): MatchResult[] {
  const candidates = buildCandidates(data).filter((c) => c.paths.length > 0 || c.text.trim())
  const queryPaths = collectQueryPaths(context)
  const queryTokens = tokenize(`${context.intent} ${context.scope}`)
  const bm25 = makeBm25(candidates.map((c) => tokenize(c.text)))
  const now = context.now ?? Date.now()

  const results: MatchResult[] = []
  candidates.forEach((candidate, i) => {
    const S = structuralScore(candidate.paths, queryPaths, data.coChanges)
    if (candidate.minStructural && S < candidate.minStructural) return
    const L = lexicalMultiplier(bm25(queryTokens, i))
    const C = CONFIDENCE_WEIGHT[candidate.confidence ?? 'probable']
    const R = candidate.timestamp ? recencyWeight(candidate.timestamp, now) : 1
    const score = S * L * C * R
    if (score < MIN_SCORE) return

    results.push({
      matchType: candidate.matchType,
      severity: candidate.severityFor(S),
      title: candidate.title,
      description: candidate.description,
      source: candidate.source,
      component: candidate.component,
      recommendation: candidate.recommendation,
      recordId: candidate.recordId,
      score: Math.round(score * 1000) / 1000,
    })
  })

  // Sort BEFORE dedup so the strongest record per type+component survives
  // (e.g. a confirmed decision beats an uncertain one on the same file).
  results.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.score - a.score,
  )

  const seen = new Set<string>()
  const deduplicated: MatchResult[] = []
  for (const result of results) {
    const key = `${result.matchType}:${result.component.toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      deduplicated.push(result)
    }
  }
  return deduplicated
}
