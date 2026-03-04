import * as path from 'path'
import { readJsonOrNull } from '@/storage/reader.js'
import { writeAtomic, mergeObject } from '@/storage/writer.js'
import * as fs from 'fs/promises'

/**
 * The hippocampus is MATHA's long-term memory.
 * It stores intent, rules, decisions, danger zones, and open questions.
 *
 * All data lives in .matha/hippocampus/
 * Never touches the filesystem directly — only through the storage layer.
 */

// ── TYPES ────────────────────────────────────────────────────────────

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
  confidence: 'confirmed' | 'probable' | 'uncertain'
  status: 'active' | 'superseded' | 'invalidated'
  supersedes: string | null
  session_id: string
}

export interface DangerZone {
  id: string
  component: string
  pattern: string
  description: string
}

export interface OpenQuestion {
  id: string
  question: string
  context: string
  status: 'open' | 'answered' | 'deferred'
}

// ── INTENT ───────────────────────────────────────────────────────────

/**
 * Returns the project intent, or null if not yet defined.
 */
export async function getIntent(
  mathaDir: string,
): Promise<IntentRecord | null> {
  const intentPath = path.join(mathaDir, 'hippocampus', 'intent.json')
  return await readJsonOrNull<IntentRecord>(intentPath)
}

// ── RULES ────────────────────────────────────────────────────────────

/**
 * Returns all non-negotiable business rules, or an empty array if none exist.
 */
export async function getRules(mathaDir: string): Promise<string[]> {
  const rulesPath = path.join(mathaDir, 'hippocampus', 'rules.json')
  const data = await readJsonOrNull<{ rules?: string[] }>(rulesPath)
  return data?.rules ?? []
}

// ── DECISIONS ────────────────────────────────────────────────────────

/**
 * Records a decision entry to the decision log.
 * Decision log is append-only: never modifies existing entries.
 *
 * @throws if a decision with the same id already exists
 */
export async function recordDecision(
  mathaDir: string,
  entry: DecisionEntry,
): Promise<void> {
  const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
  const decisionPath = path.join(decisionsDir, `${entry.id}.json`)

  // Guard: reject if decision with this id already exists
  try {
    await fs.access(decisionPath)
    throw new Error(`Decision with id '${entry.id}' already exists`)
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
    // File does not exist — proceed
  }

  await writeAtomic(decisionPath, entry)
}

/**
 * Returns all decision entries, optionally filtered by component.
 * Results are sorted by timestamp descending (most recent first).
 *
 * @param component - Optional filter by component name
 * @param limit - Optional limit on number of results
 */
export async function getDecisions(
  mathaDir: string,
  component?: string,
  limit?: number,
): Promise<DecisionEntry[]> {
  const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')

  let files: string[]
  try {
    files = await fs.readdir(decisionsDir)
  } catch (err: any) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'))

  const entries: DecisionEntry[] = []
  for (const file of jsonFiles) {
    const filePath = path.join(decisionsDir, file)
    try {
      const entry = await readJsonOrNull<DecisionEntry>(filePath)
      if (entry) entries.push(entry)
    } catch {
      // Skip malformed files
    }
  }

  // Filter by component if provided
  let filtered = component
    ? entries.filter((e) => e.component === component)
    : entries

  // Sort by timestamp descending (most recent first)
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  // Apply limit if provided
  if (limit !== undefined && limit > 0) {
    filtered = filtered.slice(0, limit)
  }

  return filtered
}

// ── DANGER ZONES ─────────────────────────────────────────────────────

/**
 * Returns all danger zones, optionally filtered by context string.
 *
 * Context matching checks both component and description fields
 * (case-insensitive).
 *
 * @param context - Optional context string to filter by
 */
export async function getDangerZones(
  mathaDir: string,
  context?: string,
): Promise<DangerZone[]> {
  const dangerZonesPath = path.join(
    mathaDir,
    'hippocampus',
    'danger-zones.json',
  )
  const data = await readJsonOrNull<{ zones?: DangerZone[] }>(dangerZonesPath)
  const zones = data?.zones ?? []

  if (!context) return zones

  const contextLower = context.toLowerCase()
  return zones.filter(
    (zone) =>
      zone.component.toLowerCase().includes(contextLower) ||
      zone.description.toLowerCase().includes(contextLower),
  )
}

/**
 * Records a new danger zone.
 */
export async function recordDangerZone(
  mathaDir: string,
  zone: DangerZone,
): Promise<void> {
  const dangerZonesPath = path.join(
    mathaDir,
    'hippocampus',
    'danger-zones.json',
  )

  const existing = await readJsonOrNull<{ zones: DangerZone[] }>(
    dangerZonesPath,
  )
  const zones = existing?.zones ?? []
  zones.push(zone)

  await writeAtomic(dangerZonesPath, { zones }, { overwrite: true })
}

// ── OPEN QUESTIONS ───────────────────────────────────────────────────

/**
 * Returns all open questions, or an empty array if none exist.
 */
export async function getOpenQuestions(
  mathaDir: string,
): Promise<OpenQuestion[]> {
  const questionsPath = path.join(
    mathaDir,
    'hippocampus',
    'open-questions.json',
  )
  const data = await readJsonOrNull<{ questions?: OpenQuestion[] }>(
    questionsPath,
  )
  return data?.questions ?? []
}

/**
 * Records a new open question.
 */
export async function recordOpenQuestion(
  mathaDir: string,
  question: OpenQuestion,
): Promise<void> {
  const questionsPath = path.join(
    mathaDir,
    'hippocampus',
    'open-questions.json',
  )

  const existing = await readJsonOrNull<{ questions: OpenQuestion[] }>(
    questionsPath,
  )
  const questions = existing?.questions ?? []
  questions.push(question)

  await writeAtomic(questionsPath, { questions }, { overwrite: true })
}
