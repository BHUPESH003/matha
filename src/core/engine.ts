import * as fs from 'fs/promises'
import * as path from 'path'
import {
  normalisePath,
  type Contract,
  type DangerZone,
  type DecisionEntry,
  type IntentRecord,
} from '@/core/schema.js'
import type { StabilityRecord } from '@/codemap/index.js'
import type { CoChangeRecord } from '@/codemap/git-analyser.js'
import { matchAll, type BrainData, type MatchContext, type MatchResult } from '@/retrieve/match.js'

/**
 * The engine is the composition root: the only API the CLI and MCP surfaces
 * are allowed to call for reads and retrieval. It owns the in-memory index.
 *
 * THE INDEX: an Engine instance is long-lived (one per MCP server process /
 * CLI invocation) and caches every parsed JSON file keyed by absolute path,
 * invalidated by mtime+size. First read hits disk; subsequent reads are
 * in-memory. Writes go through the store modules and naturally invalidate
 * via the changed mtime — no explicit cache-bust calls needed anywhere.
 *
 * ponytail: mtime+size check per read (one stat syscall) instead of fs
 * watchers — correct, simple, and fast enough (sub-ms warm reads). Upgrade
 * to fs.watch only if stat overhead ever shows up in the eval harness's
 * latency metric. Retrieval itself is a linear scan over cached records —
 * fine to ~10k records; add a path-prefix index here if that ceiling hits.
 */

interface CacheEntry {
  mtimeMs: number
  size: number
  data: unknown
}

export interface EngineCounts {
  rules: number
  decisions: number
  dangerZones: number
  contracts: number
  stabilityRecords: number
  coChangePairs: number
}

export interface Diagnostics {
  brainDir: string
  recordsConsidered: number
}

export class Engine {
  private cache = new Map<string, CacheEntry>()

  constructor(readonly mathaDir: string) {}

  // ── CACHED FILE ACCESS ───────────────────────────────────────────

  private async cachedJson<T>(absPath: string): Promise<T | null> {
    let stat
    try {
      stat = await fs.stat(absPath)
    } catch {
      this.cache.delete(absPath)
      return null
    }

    const hit = this.cache.get(absPath)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.data as T
    }

    let data: T | null
    try {
      data = JSON.parse(await fs.readFile(absPath, 'utf-8')) as T
    } catch {
      data = null // malformed JSON is treated as missing, never fatal to retrieval
    }
    this.cache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, data })
    return data
  }

  private async cachedDirJson<T>(absDir: string): Promise<T[]> {
    let files: string[]
    try {
      files = await fs.readdir(absDir)
    } catch {
      return []
    }
    const out: T[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const item = await this.cachedJson<T>(path.join(absDir, f))
      if (item) out.push(item)
    }
    return out
  }

  // ── RECORD READS ─────────────────────────────────────────────────

  async getIntent(): Promise<IntentRecord | null> {
    return await this.cachedJson<IntentRecord>(
      path.join(this.mathaDir, 'hippocampus', 'intent.json'),
    )
  }

  async getRules(): Promise<string[]> {
    const data = await this.cachedJson<{ rules?: string[] }>(
      path.join(this.mathaDir, 'hippocampus', 'rules.json'),
    )
    return data?.rules ?? []
  }

  async getDangerZones(context?: string): Promise<DangerZone[]> {
    const data = await this.cachedJson<{ zones?: DangerZone[] }>(
      path.join(this.mathaDir, 'hippocampus', 'danger-zones.json'),
    )
    const zones = data?.zones ?? []
    if (!context) return zones
    const contextLower = context.toLowerCase()
    return zones.filter(
      (z) =>
        z.component.toLowerCase().includes(contextLower) ||
        z.description.toLowerCase().includes(contextLower),
    )
  }

  async getDecisions(component?: string, limit?: number): Promise<DecisionEntry[]> {
    const all = await this.cachedDirJson<DecisionEntry>(
      path.join(this.mathaDir, 'hippocampus', 'decisions'),
    )
    let filtered = component ? all.filter((d) => d.component === component) : [...all]
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    if (limit !== undefined && limit > 0) filtered = filtered.slice(0, limit)
    return filtered
  }

  async getContracts(): Promise<Contract[]> {
    return await this.cachedDirJson<Contract>(
      path.join(this.mathaDir, 'cerebellum', 'contracts'),
    )
  }

  async getStabilityRecords(): Promise<StabilityRecord[]> {
    const records = await this.cachedJson<StabilityRecord[]>(
      path.join(this.mathaDir, 'cortex', 'stability.json'),
    )
    return Array.isArray(records) ? records : []
  }

  /**
   * Stability lookup for specific files — the ONE implementation (0.1.x had
   * two that disagreed). Normalised, case-insensitive path comparison.
   */
  async stabilityFor(files: string[]): Promise<Record<string, StabilityRecord | null>> {
    const records = await this.getStabilityRecords()
    const byPath = new Map<string, StabilityRecord>()
    for (const r of records) byPath.set(normalisePath(r.filepath), r)

    const result: Record<string, StabilityRecord | null> = {}
    for (const f of files) {
      result[f] = byPath.get(normalisePath(f)) ?? null
    }
    return result
  }

  async getCoChanges(): Promise<CoChangeRecord[]> {
    const pairs = await this.cachedJson<CoChangeRecord[]>(
      path.join(this.mathaDir, 'cortex', 'co-changes.json'),
    )
    return Array.isArray(pairs) ? pairs : []
  }

  // ── RETRIEVAL ────────────────────────────────────────────────────

  async loadBrain(): Promise<BrainData> {
    const [dangerZones, contracts, stability, decisions, coChanges] = await Promise.all([
      this.getDangerZones(),
      this.getContracts(),
      this.getStabilityRecords(),
      this.getDecisions(),
      this.getCoChanges(),
    ])
    return { dangerZones, contracts, stability, decisions, coChanges }
  }

  async match(context: MatchContext): Promise<{ results: MatchResult[]; diagnostics: Diagnostics }> {
    const data = await this.loadBrain()
    const results = matchAll(context, data)
    return {
      results,
      diagnostics: {
        brainDir: this.mathaDir,
        recordsConsidered:
          data.dangerZones.length +
          data.contracts.length +
          data.stability.length +
          data.decisions.length,
      },
    }
  }

  // ── DIAGNOSTICS ──────────────────────────────────────────────────

  async counts(): Promise<EngineCounts> {
    const [rules, decisions, zones, contracts, stability, coChanges] = await Promise.all([
      this.getRules(),
      this.getDecisions(),
      this.getDangerZones(),
      this.getContracts(),
      this.getStabilityRecords(),
      this.getCoChanges(),
    ])
    return {
      rules: rules.length,
      decisions: decisions.length,
      dangerZones: zones.length,
      contracts: contracts.length,
      stabilityRecords: stability.length,
      coChangePairs: coChanges.length,
    }
  }
}
