/**
 * Single source of truth for record types, validation, filename
 * sanitization, and the schema version. Every surface (CLI, MCP) and every
 * store module must import these from here — never redefine locally.
 */

/**
 * 1.0.0 → 1.1.0: decisions/<component>.json (JSON array, read-modify-write)
 * → decisions/<component>.jsonl (one entry per line, append-only). A repo
 * still on 1.0.0 has its decisions invisible to a 1.1.0 reader until
 * `matha migrate` (or `matha init`) runs migrateLegacyDecisions — see
 * commands/migrate.ts.
 */
export const CURRENT_SCHEMA_VERSION = '1.1.0'

// ── RECORD TYPES ─────────────────────────────────────────────────────

export type Confidence = 'confirmed' | 'probable' | 'uncertain'
export type RecordStatus = 'active' | 'superseded' | 'retired' | 'invalidated'

export interface IntentRecord {
  why?: string
  core_problem?: string
  core_insight?: string
  [key: string]: unknown
}

export interface DecisionEntry {
  id: string
  timestamp: string
  component: string
  previous_assumption: string
  correction: string
  trigger: string
  confidence: Confidence
  status: RecordStatus
  supersedes: string | null
  session_id: string
  /** Lifecycle metadata (Phase 4) — content fields above stay immutable. */
  superseded_by?: string | null
  retired_reason?: string
  /** Set by `matha review` confirm — resets the possiblyStale clock. */
  last_confirmed?: string
}

export interface DangerZone {
  id: string
  component: string
  pattern: string
  description: string
  status?: RecordStatus
  confidence?: Confidence
  retired_reason?: string
}

/**
 * Admin-declared boundary (§5.5): pinned, confirmed, non-decaying, always
 * CRITICAL on a direct path match. Authored via `matha boundary add` (never
 * over MCP) and stored in the repo so boundary changes are PR-reviewed.
 */
export interface BoundaryRecord {
  id: string
  component: string
  rule: string
  declaredBy: string
  created: string
  status?: RecordStatus
}

export interface ContractAssertion {
  id: string
  description: string
  type: 'invariant'
  status: 'active' | 'retired'
  violation_count: number
  last_violated: string | null
}

export interface Contract {
  component: string
  version: number
  last_updated: string
  assertions: ContractAssertion[]
}

// ── SANITIZER (the one and only) ─────────────────────────────────────

/**
 * Maps a component name to a stable filename. Used by BOTH contract
 * writes and contract lookups — any second implementation of this is a bug
 * (0.1.x had two that disagreed, so violations never found their contract).
 */
export function componentToFilename(component: string): string {
  return component.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
}

// ── VALIDATION ───────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean
  reason?: string
}

const MIN_MEANINGFUL_LENGTH = 3

function meaningful(value: unknown, field: string): ValidationResult {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, reason: `${field} is required and must be a non-empty string` }
  }
  if (value.trim().length < MIN_MEANINGFUL_LENGTH) {
    return {
      ok: false,
      reason: `${field} is too short ('${value.trim()}') — record a meaningful description, not an abbreviation`,
    }
  }
  return { ok: true }
}

export function validateDecisionInput(input: {
  component?: unknown
  previous_assumption?: unknown
  correction?: unknown
}): ValidationResult {
  for (const [field, value] of Object.entries({
    component: input.component,
    previous_assumption: input.previous_assumption,
    correction: input.correction,
  })) {
    const r = meaningful(value, field)
    if (!r.ok) return r
  }
  return { ok: true }
}

export function validateDangerInput(input: {
  component?: unknown
  description?: unknown
}): ValidationResult {
  for (const [field, value] of Object.entries({
    component: input.component,
    description: input.description,
  })) {
    const r = meaningful(value, field)
    if (!r.ok) return r
  }
  return { ok: true }
}

export function validateBoundaryInput(input: {
  component?: unknown
  rule?: unknown
}): ValidationResult {
  for (const [field, value] of Object.entries({
    component: input.component,
    rule: input.rule,
  })) {
    const r = meaningful(value, field)
    if (!r.ok) return r
  }
  return { ok: true }
}

export function validateContractInput(input: {
  component?: unknown
  assertions?: unknown
}): ValidationResult {
  const c = meaningful(input.component, 'component')
  if (!c.ok) return c
  if (!Array.isArray(input.assertions) || input.assertions.length === 0) {
    return { ok: false, reason: 'assertions must be a non-empty array of strings' }
  }
  for (const a of input.assertions) {
    const r = meaningful(a, 'assertion')
    if (!r.ok) return r
  }
  return { ok: true }
}

// ── NEAR-DUPLICATE DETECTION (write-time) ────────────────────────────

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  )
}

// Jaccard ≥ 0.7 catches near-verbatim rewording (same rough length on both
// sides). Overlap coefficient (intersection / smaller set) also catches an
// expanded or contracted paraphrase — a longer restatement that keeps most
// of the original's key terms scores low on Jaccard (the union balloons)
// but high here. Found in the field: a real LLM paraphrase of an existing
// decision scored 0.22 Jaccard (missed) but 0.54 overlap (caught) — this is
// the intersection-only signal that closes that gap without embeddings.
// MIN_SHARED_WORDS guards short text: two 3-word descriptions sharing 2
// stopword-filtered words would otherwise hit 0.66 overlap by chance.
const JACCARD_THRESHOLD = 0.7
const OVERLAP_THRESHOLD = 0.5
const MIN_SHARED_WORDS = 4

/**
 * Lexical near-duplicate check for writes. Agents re-record the same
 * learning in different words; the brain should say "already known" instead
 * of accumulating echoes. Two independent signals, either can fire — a false
 * rejection loses one record, a lax check pollutes ranking, so both
 * thresholds are calibrated to sit clear of genuinely-different corrections
 * (tests/eval and tests/core/schema.test.ts pin the margins).
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const setA = wordSet(a)
  const setB = wordSet(b)
  if (setA.size === 0 || setB.size === 0) return false
  let intersection = 0
  for (const w of setA) if (setB.has(w)) intersection++
  if (intersection < MIN_SHARED_WORDS) return false
  const jaccard = intersection / (setA.size + setB.size - intersection)
  const overlap = intersection / Math.min(setA.size, setB.size)
  return jaccard >= JACCARD_THRESHOLD || overlap >= OVERLAP_THRESHOLD
}

/** First active record whose text near-duplicates the candidate, or null. */
export function findNearDuplicate<T>(
  candidateText: string,
  existing: T[],
  textOf: (record: T) => string,
): T | null {
  for (const record of existing) {
    if (isNearDuplicate(candidateText, textOf(record))) return record
  }
  return null
}

// ── PATH NORMALISATION (shared by matcher and engine) ────────────────

/** Normalise a path for comparison: forward slashes, no leading ./ or /, lowercase. */
export function normalisePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Split a component string into path-like parts and free-text parts.
 * "src/auth.ts, payment logic" → paths: ['src/auth.ts'], texts: ['payment logic'].
 * A part counts as path-like if it contains '/' or looks like a filename.
 */
export function splitComponent(component: string): { paths: string[]; texts: string[] } {
  const paths: string[] = []
  const texts: string[] = []
  for (const raw of component.split(',')) {
    const part = raw.trim()
    if (!part) continue
    if (part.includes('/') || /^[\w.-]+\.\w+$/.test(part)) {
      paths.push(normalisePath(part))
    } else {
      texts.push(part)
    }
  }
  return { paths, texts }
}
