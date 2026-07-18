/**
 * Single source of truth for record types, validation, filename
 * sanitization, and the schema version. Every surface (CLI, MCP) and every
 * store module must import these from here — never redefine locally.
 */

export const CURRENT_SCHEMA_VERSION = '0.2.0'

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
}

export interface DangerZone {
  id: string
  component: string
  pattern: string
  description: string
  status?: RecordStatus
  confidence?: Confidence
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

/**
 * Lexical near-duplicate check for writes: Jaccard word overlap ≥ 0.7.
 * Agents re-record the same learning in slightly different words; the brain
 * should say "already known" instead of accumulating echoes. Strict on
 * purpose — a false rejection loses one record, a lax check pollutes ranking.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const setA = wordSet(a)
  const setB = wordSet(b)
  if (setA.size === 0 || setB.size === 0) return false
  let intersection = 0
  for (const w of setA) if (setB.has(w)) intersection++
  return intersection / (setA.size + setB.size - intersection) >= 0.7
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
