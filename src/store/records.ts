import * as path from 'path'
import * as fs from 'fs/promises'
import { readJsonOrNull } from '@/storage/reader.js'
import { writeAtomic } from '@/storage/writer.js'
import {
  componentToFilename,
  type BoundaryRecord,
  type Confidence,
  type Contract,
  type DangerZone,
  type DecisionEntry,
  type IntentRecord,
  type RecordStatus,
} from '@/core/schema.js'

/**
 * Read/write operations for knowledge records (intent, rules, decisions,
 * danger zones, contracts). This is the only module that knows the on-disk
 * layout of these records. All filename derivation goes through
 * componentToFilename — never a local sanitizer.
 */

// ── INTENT ───────────────────────────────────────────────────────────

export async function getIntent(mathaDir: string): Promise<IntentRecord | null> {
  return await readJsonOrNull<IntentRecord>(path.join(mathaDir, 'hippocampus', 'intent.json'))
}

// ── RULES ────────────────────────────────────────────────────────────

export async function getRules(mathaDir: string): Promise<string[]> {
  const data = await readJsonOrNull<{ rules?: string[] }>(
    path.join(mathaDir, 'hippocampus', 'rules.json'),
  )
  return data?.rules ?? []
}

// ── DECISIONS ────────────────────────────────────────────────────────

/**
 * Records a decision entry. Append-only: never modifies existing entries.
 * @throws if a decision with the same id already exists
 */
export async function recordDecision(mathaDir: string, entry: DecisionEntry): Promise<void> {
  const decisionPath = path.join(mathaDir, 'hippocampus', 'decisions', `${entry.id}.json`)
  try {
    await fs.access(decisionPath)
    throw new Error(`Decision with id '${entry.id}' already exists`)
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }
  await writeAtomic(decisionPath, entry)
}

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

  const entries: DecisionEntry[] = []
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const entry = await readJsonOrNull<DecisionEntry>(path.join(decisionsDir, file))
      if (entry) entries.push(entry)
    } catch {
      // Skip malformed files
    }
  }

  let filtered = component ? entries.filter((e) => e.component === component) : entries
  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  if (limit !== undefined && limit > 0) filtered = filtered.slice(0, limit)
  return filtered
}

// ── LIFECYCLE (Phase 4) ──────────────────────────────────────────────
//
// Decision history is append-only in CONTENT: assumption, correction,
// component and timestamps are never rewritten. Lifecycle is metadata —
// status, confidence, retire reason, supersede links — and amending it in
// place is the designed exception (RecordStatus existed from day one).

export interface LifecyclePatch {
  status?: RecordStatus
  confidence?: Confidence
  retired_reason?: string
  superseded_by?: string | null
  last_confirmed?: string
}

/** Applies a lifecycle patch to a decision. Returns false if the id is unknown. */
export async function updateDecisionLifecycle(
  mathaDir: string,
  id: string,
  patch: LifecyclePatch,
): Promise<boolean> {
  const decisionPath = path.join(mathaDir, 'hippocampus', 'decisions', `${id}.json`)
  const entry = await readJsonOrNull<DecisionEntry>(decisionPath)
  if (!entry) return false
  await writeAtomic(decisionPath, { ...entry, ...patch }, { overwrite: true })
  return true
}

/** Applies a lifecycle patch to a danger zone. Returns false if the id is unknown. */
export async function updateDangerZoneLifecycle(
  mathaDir: string,
  id: string,
  patch: LifecyclePatch,
): Promise<boolean> {
  const dangerZonesPath = path.join(mathaDir, 'hippocampus', 'danger-zones.json')
  const existing = await readJsonOrNull<{ zones: DangerZone[] }>(dangerZonesPath)
  const zones = existing?.zones ?? []
  const zone = zones.find((z) => z.id === id)
  if (!zone) return false
  Object.assign(zone, patch)
  await writeAtomic(dangerZonesPath, { zones }, { overwrite: true })
  return true
}

// ── BOUNDARIES (admin-declared, §5.5) ────────────────────────────────

export async function getBoundaries(mathaDir: string): Promise<BoundaryRecord[]> {
  const data = await readJsonOrNull<{ boundaries?: BoundaryRecord[] }>(
    path.join(mathaDir, 'hippocampus', 'boundaries.json'),
  )
  return data?.boundaries ?? []
}

export async function recordBoundary(mathaDir: string, boundary: BoundaryRecord): Promise<void> {
  const boundariesPath = path.join(mathaDir, 'hippocampus', 'boundaries.json')
  const existing = await readJsonOrNull<{ boundaries: BoundaryRecord[] }>(boundariesPath)
  const boundaries = existing?.boundaries ?? []
  boundaries.push(boundary)
  await writeAtomic(boundariesPath, { boundaries }, { overwrite: true })
}

// ── DANGER ZONES ─────────────────────────────────────────────────────

export async function getDangerZones(mathaDir: string, context?: string): Promise<DangerZone[]> {
  const data = await readJsonOrNull<{ zones?: DangerZone[] }>(
    path.join(mathaDir, 'hippocampus', 'danger-zones.json'),
  )
  const zones = data?.zones ?? []
  if (!context) return zones

  const contextLower = context.toLowerCase()
  return zones.filter(
    (zone) =>
      zone.component.toLowerCase().includes(contextLower) ||
      zone.description.toLowerCase().includes(contextLower),
  )
}

export async function recordDangerZone(mathaDir: string, zone: DangerZone): Promise<void> {
  const dangerZonesPath = path.join(mathaDir, 'hippocampus', 'danger-zones.json')
  const existing = await readJsonOrNull<{ zones: DangerZone[] }>(dangerZonesPath)
  const zones = existing?.zones ?? []
  zones.push(zone)
  await writeAtomic(dangerZonesPath, { zones }, { overwrite: true })
}

// ── CONTRACTS ────────────────────────────────────────────────────────

function contractPath(mathaDir: string, component: string): string {
  return path.join(mathaDir, 'cerebellum', 'contracts', `${componentToFilename(component)}.json`)
}

/** Records (or overwrites) the behaviour contract for a component. */
export async function recordContract(
  mathaDir: string,
  component: string,
  assertions: string[],
): Promise<void> {
  const existing = await readJsonOrNull<Contract>(contractPath(mathaDir, component))
  const contract: Contract = {
    component,
    version: (existing?.version ?? 0) + 1,
    last_updated: new Date().toISOString(),
    assertions: assertions.map((description, idx) => ({
      id: `${componentToFilename(component)}-assertion-${idx}`,
      description,
      type: 'invariant' as const,
      status: 'active' as const,
      violation_count: 0,
      last_violated: null,
    })),
  }
  await writeAtomic(contractPath(mathaDir, component), contract, { overwrite: true })
}

export async function getContracts(mathaDir: string): Promise<Contract[]> {
  const contractsDir = path.join(mathaDir, 'cerebellum', 'contracts')
  let files: string[]
  try {
    files = await fs.readdir(contractsDir)
  } catch {
    return []
  }

  const contracts: Contract[] = []
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = await readJsonOrNull<Contract>(path.join(contractsDir, file))
      if (parsed?.component) contracts.push(parsed)
    } catch {
      // skip malformed files
    }
  }
  return contracts
}

/**
 * Increments the violation count on a contract assertion matching the given
 * text. Uses the same filename derivation as recordContract, so the lookup
 * always finds the file recordContract wrote.
 */
export async function recordContractViolation(
  mathaDir: string,
  component: string,
  assertionText: string,
  timestamp: string,
): Promise<boolean> {
  const contract = await readJsonOrNull<Contract>(contractPath(mathaDir, component))
  if (!contract || !Array.isArray(contract.assertions)) return false

  const searchTarget = assertionText.trim().toLowerCase()
  let modified = false
  for (const assertion of contract.assertions) {
    if (assertion.description?.trim().toLowerCase() === searchTarget) {
      assertion.violation_count = (assertion.violation_count || 0) + 1
      assertion.last_violated = timestamp
      modified = true
    }
  }

  if (modified) {
    await writeAtomic(contractPath(mathaDir, component), contract, { overwrite: true })
  }
  return modified
}
