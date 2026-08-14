import * as path from 'path'
import * as fs from 'fs/promises'
import { readJsonOrNull, readJsonLines } from '@/storage/reader.js'
import { appendJsonLine, writeAtomic, writeTextAtomic } from '@/storage/writer.js'
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
//
// One file per COMPONENT, not per decision — `decisions/<component>.jsonl`
// holds one DecisionEntry per line. A session that records five
// corrections to the same module lands in one file, not five; two
// sessions on unrelated components still never touch the same file.
//
// JSON-lines, not a JSON array, specifically so recordDecision never has
// to read-modify-write the file — it only ever appends a line. Two team
// members' agents both landing a decision on the same component at the
// same time used to race on a single read-modify-rename cycle and could
// silently drop whichever wrote second. A raw append can't lose a write
// that way: both lines land, in whatever order the OS scheduled them.
// Append-only still holds — recordDecision only ever appends, never
// rewrites an existing line.

function decisionFilePath(mathaDir: string, component: string): string {
  return path.join(mathaDir, 'hippocampus', 'decisions', `${componentToFilename(component)}.jsonl`)
}

/** Whole-file JSONL rewrite — only for single-actor operations (migration,
 * lifecycle patch) where read-modify-write is acceptable. recordDecision
 * never uses this; it only appends. */
async function writeDecisionsFile(filePath: string, entries: DecisionEntry[]): Promise<void> {
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  await writeTextAtomic(filePath, text)
}

/**
 * Records a decision entry by appending it as one line to its component's
 * file. Append-only: never modifies existing entries.
 *
 * The duplicate-id check reads the file first, so it is best-effort under
 * true concurrency (two processes could both pass the check before either
 * appends) — but ids are `Date.now()` + random bytes (see mcp/tools.ts,
 * commands/after.ts), so a collision between independent writers isn't a
 * realistic case. What this reliably catches is a caller retrying the same
 * write (e.g. an MCP client resending on timeout).
 * @throws if a decision with the same id already exists
 */
export async function recordDecision(mathaDir: string, entry: DecisionEntry): Promise<void> {
  const filePath = decisionFilePath(mathaDir, entry.component)
  const existing = await readJsonLines<DecisionEntry>(filePath)
  if (existing.some((d) => d.id === entry.id)) {
    throw new Error(`Decision with id '${entry.id}' already exists`)
  }
  await appendJsonLine(filePath, entry)
}

export async function getDecisions(
  mathaDir: string,
  component?: string,
  limit?: number,
): Promise<DecisionEntry[]> {
  const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')

  let entries: DecisionEntry[]
  if (component) {
    entries = await readJsonLines<DecisionEntry>(decisionFilePath(mathaDir, component))
  } else {
    let files: string[]
    try {
      files = await fs.readdir(decisionsDir)
    } catch (err: any) {
      if (err.code === 'ENOENT') return []
      throw err
    }

    entries = []
    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      entries.push(...(await readJsonLines<DecisionEntry>(path.join(decisionsDir, file))))
    }
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return limit !== undefined && limit > 0 ? entries.slice(0, limit) : entries
}

/**
 * One-time upgrade for repos still on a pre-1.2 layout: either the
 * pre-1.1 shape (one file per decision, named by id, holding a bare
 * DecisionEntry) or the 1.1 shape (`decisions/<component>.json` holding
 * `{ component, decisions: DecisionEntry[] }`). Both are consolidated into
 * `decisions/<component>.jsonl` and the old `.json` files removed.
 * Idempotent — once migrated, no `.json` files remain to convert. Called
 * from `matha init` so re-running init on an existing repo upgrades it;
 * never runs on the hot read path.
 */
export async function migrateLegacyDecisions(mathaDir: string): Promise<number> {
  const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
  let files: string[]
  try {
    files = await fs.readdir(decisionsDir)
  } catch {
    return 0
  }

  const byComponent = new Map<string, DecisionEntry[]>()
  const consumedFiles: string[] = []

  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const parsed = await readJsonOrNull<DecisionEntry | { component: string; decisions: DecisionEntry[] }>(
      path.join(decisionsDir, file),
    )
    if (!parsed) continue

    if ('decisions' in parsed && Array.isArray(parsed.decisions)) {
      // 1.1 grouped-array shape
      const bucket = byComponent.get(parsed.component) ?? []
      bucket.push(...parsed.decisions)
      byComponent.set(parsed.component, bucket)
      consumedFiles.push(file)
    } else if (
      'id' in parsed &&
      typeof (parsed as DecisionEntry).component === 'string' &&
      typeof (parsed as DecisionEntry).timestamp === 'string'
    ) {
      // pre-1.1 bare-entry shape. Stray/malformed files (e.g. a leftover
      // manual validation report with no `component` field) don't match
      // either branch and are left alone rather than crashing the
      // migration.
      const entry = parsed as DecisionEntry
      const bucket = byComponent.get(entry.component) ?? []
      bucket.push(entry)
      byComponent.set(entry.component, bucket)
      consumedFiles.push(file)
    }
  }

  if (byComponent.size === 0) return 0

  let migratedCount = 0
  for (const [component, newEntries] of byComponent) {
    const jsonlPath = decisionFilePath(mathaDir, component)
    const merged = [...(await readJsonLines<DecisionEntry>(jsonlPath)), ...newEntries]
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    await writeDecisionsFile(jsonlPath, merged)
    migratedCount += newEntries.length
  }

  for (const file of consumedFiles) {
    await fs.unlink(path.join(decisionsDir, file))
  }
  return migratedCount
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

/**
 * Applies a lifecycle patch to a decision. The caller only has the id, not
 * its component, so this scans group files the same way getDecisions()
 * already does for an unscoped read — cheap, since there's one file per
 * component, not per decision. Returns false if the id is unknown.
 */
export async function updateDecisionLifecycle(
  mathaDir: string,
  id: string,
  patch: LifecyclePatch,
): Promise<boolean> {
  const decisionsDir = path.join(mathaDir, 'hippocampus', 'decisions')
  let files: string[]
  try {
    files = await fs.readdir(decisionsDir)
  } catch {
    return false
  }

  for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
    const filePath = path.join(decisionsDir, file)
    const entries = await readJsonLines<DecisionEntry>(filePath)
    const entry = entries.find((d) => d.id === id)
    if (entry) {
      Object.assign(entry, patch)
      await writeDecisionsFile(filePath, entries)
      return true
    }
  }
  return false
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
