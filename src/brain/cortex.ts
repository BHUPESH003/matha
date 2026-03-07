import * as path from 'path'
import { readJsonOrNull } from '@/storage/reader.js'
import { writeAtomic } from '@/storage/writer.js'
import { analyseRepository, type CoChangeRecord, type AnalysisOptions } from '@/analysis/git-analyser.js'
import { classifyStability, type ClassificationOptions } from '@/analysis/stability-classifier.js'

// ──────────────────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────────────────

export interface StabilityRecord {
  filepath: string
  stability: 'frozen' | 'stable' | 'volatile' | 'disposable' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  classificationSource: 'derived' | 'declared'
  declaredBy?: string
  declaredAt?: string
  changeCount: number
  coChangeCount: number
  ageInDays: number
  daysSinceLastChange: number
  lastDerivedAt?: string
}

export interface CortexSnapshot {
  updatedAt: string
  repoPath: string
  commitCount: number
  fileCount: number
  stability: StabilityRecord[]
  coChanges: CoChangeRecord[]
  summary: {
    frozen: number
    stable: number
    volatile: number
    disposable: number
    declared: number
  }
}

// ──────────────────────────────────────────────────────────────
// PATHS
// ──────────────────────────────────────────────────────────────

function stabilityPath(mathaDir: string): string {
  return path.join(mathaDir, 'cortex', 'stability.json')
}

function coChangesPath(mathaDir: string): string {
  return path.join(mathaDir, 'cortex', 'co-changes.json')
}

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

function normalisePath(filepath: string): string {
  return filepath.replace(/\\/g, '/')
}

function buildSummary(records: StabilityRecord[]) {
  const summary = { frozen: 0, stable: 0, volatile: 0, disposable: 0, declared: 0 }
  for (const r of records) {
    if (r.stability === 'frozen') summary.frozen++
    else if (r.stability === 'stable') summary.stable++
    else if (r.stability === 'volatile') summary.volatile++
    else if (r.stability === 'disposable') summary.disposable++
    if (r.classificationSource === 'declared') summary.declared++
  }
  return summary
}

// ──────────────────────────────────────────────────────────────
// refreshFromGit
// ──────────────────────────────────────────────────────────────

/**
 * Run git analysis + stability classification and persist results.
 * Preserves any existing `declared` records (declared-wins invariant).
 *
 * **Never throws** — empty repo produces empty cortex.
 */
export async function refreshFromGit(
  repoPath: string,
  mathaDir: string,
  options?: AnalysisOptions,
): Promise<CortexSnapshot> {
  try {
    const now = new Date().toISOString()

    // Run analysis pipeline
    const analysis = await analyseRepository(repoPath, options)
    const classification = classifyStability(analysis)

    // Load existing stability records (to preserve declared)
    const existing = await readJsonOrNull<StabilityRecord[]>(stabilityPath(mathaDir))
    const declaredMap = new Map<string, StabilityRecord>()
    if (existing && Array.isArray(existing)) {
      for (const r of existing) {
        if (r.classificationSource === 'declared') {
          declaredMap.set(normalisePath(r.filepath), r)
        }
      }
    }

    // Build new stability records
    const records: StabilityRecord[] = []
    for (const c of classification.classifications) {
      const fp = normalisePath(c.filepath)
      const declared = declaredMap.get(fp)

      if (declared) {
        // Preserve declared, only update lastDerivedAt
        records.push({
          ...declared,
          filepath: fp,
          lastDerivedAt: now,
        })
        declaredMap.delete(fp) // mark as handled
      } else {
        records.push({
          filepath: fp,
          stability: c.stability,
          confidence: c.confidence,
          reason: c.reason,
          classificationSource: 'derived',
          changeCount: c.changeCount,
          coChangeCount: c.coChangeCount,
          ageInDays: c.ageInDays,
          daysSinceLastChange: c.daysSinceLastChange,
          lastDerivedAt: now,
        })
      }
    }

    // Keep any declared records for files not in current git analysis
    for (const declared of declaredMap.values()) {
      records.push({
        ...declared,
        filepath: normalisePath(declared.filepath),
        lastDerivedAt: now,
      })
    }

    // Write stability.json
    await writeAtomic(stabilityPath(mathaDir), records, { overwrite: true })

    // Write co-changes.json
    await writeAtomic(coChangesPath(mathaDir), analysis.coChanges, { overwrite: true })

    const snapshot: CortexSnapshot = {
      updatedAt: now,
      repoPath,
      commitCount: analysis.commitCount,
      fileCount: records.length,
      stability: records,
      coChanges: analysis.coChanges,
      summary: buildSummary(records),
    }

    return snapshot
  } catch {
    const empty: CortexSnapshot = {
      updatedAt: new Date().toISOString(),
      repoPath,
      commitCount: 0,
      fileCount: 0,
      stability: [],
      coChanges: [],
      summary: { frozen: 0, stable: 0, volatile: 0, disposable: 0, declared: 0 },
    }
    return empty
  }
}

// ──────────────────────────────────────────────────────────────
// getStability
// ──────────────────────────────────────────────────────────────

/**
 * Look up stability records for specific files.
 * Returns null for any filepath not found in stability.json.
 *
 * **Never throws.**
 */
export async function getStability(
  mathaDir: string,
  filepaths: string[],
): Promise<Record<string, StabilityRecord | null>> {
  try {
    const records = await readJsonOrNull<StabilityRecord[]>(stabilityPath(mathaDir))
    const result: Record<string, StabilityRecord | null> = {}

    const recordMap = new Map<string, StabilityRecord>()
    if (records && Array.isArray(records)) {
      for (const r of records) {
        recordMap.set(normalisePath(r.filepath), r)
      }
    }

    for (const fp of filepaths) {
      const normalised = normalisePath(fp)
      result[normalised] = recordMap.get(normalised) ?? null
    }

    return result
  } catch {
    const result: Record<string, StabilityRecord | null> = {}
    for (const fp of filepaths) {
      result[normalisePath(fp)] = null
    }
    return result
  }
}

// ──────────────────────────────────────────────────────────────
// overrideStability
// ──────────────────────────────────────────────────────────────

/**
 * Set a human override for a file's stability classification.
 * Creates the record if the file is not already in stability.json.
 *
 * **Never throws.**
 */
export async function overrideStability(
  mathaDir: string,
  filepath: string,
  stability: StabilityRecord['stability'],
  reason: string,
  declaredBy: string,
): Promise<void> {
  try {
    const fp = normalisePath(filepath)
    const now = new Date().toISOString()

    let records = await readJsonOrNull<StabilityRecord[]>(stabilityPath(mathaDir))
    if (!records || !Array.isArray(records)) {
      records = []
    }

    const idx = records.findIndex(r => normalisePath(r.filepath) === fp)

    const declaredRecord: StabilityRecord = {
      filepath: fp,
      stability,
      confidence: idx >= 0 ? records[idx].confidence : 'low',
      reason,
      classificationSource: 'declared',
      declaredBy,
      declaredAt: now,
      changeCount: idx >= 0 ? records[idx].changeCount : 0,
      coChangeCount: idx >= 0 ? records[idx].coChangeCount : 0,
      ageInDays: idx >= 0 ? records[idx].ageInDays : 0,
      daysSinceLastChange: idx >= 0 ? records[idx].daysSinceLastChange : 0,
      lastDerivedAt: idx >= 0 ? records[idx].lastDerivedAt : undefined,
    }

    if (idx >= 0) {
      records[idx] = declaredRecord
    } else {
      records.push(declaredRecord)
    }

    await writeAtomic(stabilityPath(mathaDir), records, { overwrite: true })
  } catch {
    // Never throw
  }
}

// ──────────────────────────────────────────────────────────────
// getCoChanges
// ──────────────────────────────────────────────────────────────

/**
 * Read co-change pairs, optionally filtered to a specific file.
 *
 * **Never throws** — returns empty array if file missing.
 */
export async function getCoChanges(
  mathaDir: string,
  filepath?: string,
): Promise<CoChangeRecord[]> {
  try {
    const pairs = await readJsonOrNull<CoChangeRecord[]>(coChangesPath(mathaDir))
    if (!pairs || !Array.isArray(pairs)) return []

    if (!filepath) return pairs

    const fp = normalisePath(filepath)
    return pairs.filter(p => normalisePath(p.fileA) === fp || normalisePath(p.fileB) === fp)
  } catch {
    return []
  }
}

// ──────────────────────────────────────────────────────────────
// getSnapshot
// ──────────────────────────────────────────────────────────────

/**
 * Read persisted cortex data and assemble a CortexSnapshot.
 * Returns null if stability.json does not exist.
 *
 * **Never throws.**
 */
export async function getSnapshot(
  mathaDir: string,
): Promise<CortexSnapshot | null> {
  try {
    const records = await readJsonOrNull<StabilityRecord[]>(stabilityPath(mathaDir))
    if (!records || !Array.isArray(records)) return null

    const pairs = await readJsonOrNull<CoChangeRecord[]>(coChangesPath(mathaDir))
    const coChanges = pairs && Array.isArray(pairs) ? pairs : []

    // Try to read shape.json for metadata
    const shapePath = path.join(mathaDir, 'cortex', 'shape.json')
    const shape = await readJsonOrNull<Record<string, unknown>>(shapePath)

    return {
      updatedAt: new Date().toISOString(),
      repoPath: (shape?.project_root as string) ?? '',
      commitCount: 0, // Not stored in stability.json — would need separate metadata
      fileCount: records.length,
      stability: records,
      coChanges,
      summary: buildSummary(records),
    }
  } catch {
    return null
  }
}
