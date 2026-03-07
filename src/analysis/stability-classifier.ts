import type { GitAnalysisResult, FileChangeRecord } from './git-analyser.js'

// ──────────────────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────────────────

export type StabilityLevel = 'frozen' | 'stable' | 'volatile' | 'disposable'
export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface StabilityClassification {
  filepath: string
  stability: StabilityLevel
  confidence: ConfidenceLevel
  reason: string
  changeCount: number
  coChangeCount: number
  ageInDays: number
  daysSinceLastChange: number
  classificationSource: 'derived'
}

export interface ClassificationResult {
  classifiedAt: string
  fileCount: number
  classifications: StabilityClassification[]
  summary: {
    frozen: number
    stable: number
    volatile: number
    disposable: number
  }
}

export interface ClassificationOptions {
  frozenThreshold?: number
  volatileThreshold?: number
  minAgeForFrozen?: number
  repoPath?: string
}

// ──────────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────────

const DEFAULT_FROZEN_THRESHOLD = 2     // max changes/month
const DEFAULT_VOLATILE_THRESHOLD = 8   // min changes/month
const DEFAULT_MIN_AGE_FOR_FROZEN = 30  // days

// ──────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ──────────────────────────────────────────────────────────────

/**
 * Classify stability for every file in a GitAnalysisResult.
 *
 * **Never throws** — returns an empty ClassificationResult on any error.
 */
export function classifyStability(
  analysis: GitAnalysisResult,
  options?: ClassificationOptions,
): ClassificationResult {
  try {
    const frozenThreshold = options?.frozenThreshold ?? DEFAULT_FROZEN_THRESHOLD
    const volatileThreshold = options?.volatileThreshold ?? DEFAULT_VOLATILE_THRESHOLD
    const minAgeForFrozen = options?.minAgeForFrozen ?? DEFAULT_MIN_AGE_FOR_FROZEN

    const now = new Date(analysis.analysedAt || new Date().toISOString())
    const classifications: StabilityClassification[] = []

    for (const file of analysis.files) {
      const classification = classifyFile(
        file,
        now,
        frozenThreshold,
        volatileThreshold,
        minAgeForFrozen,
      )
      classifications.push(classification)
    }

    // Build summary
    const summary = { frozen: 0, stable: 0, volatile: 0, disposable: 0 }
    for (const c of classifications) {
      summary[c.stability]++
    }

    return {
      classifiedAt: new Date().toISOString(),
      fileCount: classifications.length,
      classifications,
      summary,
    }
  } catch {
    return {
      classifiedAt: new Date().toISOString(),
      fileCount: 0,
      classifications: [],
      summary: { frozen: 0, stable: 0, volatile: 0, disposable: 0 },
    }
  }
}

// ──────────────────────────────────────────────────────────────
// PER-FILE CLASSIFICATION
// ──────────────────────────────────────────────────────────────

function classifyFile(
  file: FileChangeRecord,
  now: Date,
  frozenThreshold: number,
  volatileThreshold: number,
  minAgeForFrozen: number,
): StabilityClassification {
  const { filepath, changeCount, coChangedWith } = file

  // Calculate age metrics
  const firstSeenDate = new Date(file.firstSeen)
  const lastChangedDate = new Date(file.lastChanged)

  let ageInDays = Math.floor(
    (now.getTime() - firstSeenDate.getTime()) / (1000 * 60 * 60 * 24),
  )
  if (ageInDays < 1) ageInDays = 1 // guard against division by zero

  const daysSinceLastChange = Math.floor(
    (now.getTime() - lastChangedDate.getTime()) / (1000 * 60 * 60 * 24),
  )

  // Calculate churn rate
  const changesPerMonth = (changeCount / ageInDays) * 30
  const changesPerMonthRounded = Math.round(changesPerMonth * 100) / 100

  // Co-change count
  const coChangeCount = coChangedWith.length

  // ──────────────────────────────────────────────────────────
  // CLASSIFICATION RULES (first match wins)
  // ──────────────────────────────────────────────────────────

  let stability: StabilityLevel
  let reason: string

  if (
    changesPerMonth <= frozenThreshold &&
    ageInDays >= minAgeForFrozen &&
    coChangeCount >= 3
  ) {
    // FROZEN
    stability = 'frozen'
    reason =
      `Low churn (${changesPerMonthRounded} changes/month), ` +
      `high connectivity (${coChangeCount} co-changed files), ` +
      `aged ${ageInDays} days`
  } else if (changesPerMonth >= volatileThreshold) {
    // VOLATILE
    stability = 'volatile'
    reason = `High churn (${changesPerMonthRounded} changes/month)`
  } else if (
    changesPerMonth <= frozenThreshold &&
    coChangeCount <= 1 &&
    ageInDays >= minAgeForFrozen
  ) {
    // DISPOSABLE
    stability = 'disposable'
    reason =
      `Low churn (${changesPerMonthRounded} changes/month), ` +
      `low connectivity, aged ${ageInDays} days`
  } else {
    // STABLE (catch-all)
    stability = 'stable'
    reason = `Moderate churn (${changesPerMonthRounded} changes/month)`
  }

  // ──────────────────────────────────────────────────────────
  // CONFIDENCE
  // ──────────────────────────────────────────────────────────

  let confidence: ConfidenceLevel
  if (ageInDays >= 90 && changeCount >= 5) {
    confidence = 'high'
  } else if (ageInDays >= 30 && changeCount >= 2) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  return {
    filepath,
    stability,
    confidence,
    reason,
    changeCount,
    coChangeCount,
    ageInDays,
    daysSinceLastChange,
    classificationSource: 'derived',
  }
}
