import * as fs from 'fs/promises'
import * as path from 'path'
import {
  normalisePath,
  type BoundaryRecord,
  type Contract,
  type DangerZone,
  type DecisionEntry,
  type IntentRecord,
} from '@/core/schema.js'
import { refreshFromGit, type AnalysisState, type StabilityRecord } from '@/codemap/index.js'
import type { CoChangeRecord } from '@/codemap/git-analyser.js'
import {
  matchAll,
  type BrainData,
  type MatchContext,
  type MatchResult,
  type MatchSeverity,
} from '@/retrieve/match.js'

interface MathaConfig {
  schema_version?: string
  /** Downgrade frozen-file matches from 'critical' — see BrainData.frozenFileSeverity. */
  frozenFileSeverity?: MatchSeverity
}

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
  private refreshing: Promise<void> | null = null

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

  private async cachedText(absPath: string): Promise<string | null> {
    let stat
    try {
      stat = await fs.stat(absPath)
    } catch {
      this.cache.delete(absPath)
      return null
    }
    const hit = this.cache.get(absPath)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.data as string | null
    }
    let data: string | null
    try {
      data = await fs.readFile(absPath, 'utf-8')
    } catch {
      data = null
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

  async getBoundaries(): Promise<BoundaryRecord[]> {
    const data = await this.cachedJson<{ boundaries?: BoundaryRecord[] }>(
      path.join(this.mathaDir, 'hippocampus', 'boundaries.json'),
    )
    return data?.boundaries ?? []
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

  // ── CODEMAP AUTO-REFRESH ─────────────────────────────────────────

  /**
   * Current git HEAD hash via plain file reads (.git/HEAD → ref file →
   * packed-refs). No subprocess, mtime-cached — cheap enough for every
   * retrieval call. Returns null when there is no readable .git dir
   * (including worktrees, where .git is a file — auto-refresh just skips).
   */
  private async currentHeadHash(): Promise<string | null> {
    const gitDir = path.join(path.dirname(this.mathaDir), '.git')
    const head = (await this.cachedText(path.join(gitDir, 'HEAD')))?.trim()
    if (!head) return null
    if (!head.startsWith('ref: ')) return head // detached HEAD

    const ref = head.slice(5).trim()
    const direct = (await this.cachedText(path.join(gitDir, ...ref.split('/'))))?.trim()
    if (direct) return direct

    const packed = await this.cachedText(path.join(gitDir, 'packed-refs'))
    if (packed) {
      for (const line of packed.split('\n')) {
        if (line.endsWith(` ${ref}`)) return line.split(' ')[0]
      }
    }
    return null
  }

  /**
   * Keep the codemap current on read: if git HEAD moved past the analysis
   * cursor (or no analysis exists yet), run the incremental refresh before
   * serving retrieval. Refreshes are serialized and never throw — the
   * "work done outside matha" answer for the git-derived layer (§5.1):
   * the codemap catches up by itself, no human ceremony.
   */
  private async maybeRefreshCodemap(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const head = await this.currentHeadHash()
    if (!head) return // not a git repo (or unreadable) — nothing to derive from

    const state = await this.cachedJson<AnalysisState>(
      path.join(this.mathaDir, 'cortex', 'analysis.json'),
    )
    if (state?.newestHash === head) return // current — two stats, no git spawn

    this.refreshing = refreshFromGit(path.dirname(this.mathaDir), this.mathaDir)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  // ── RETRIEVAL ────────────────────────────────────────────────────

  async loadBrain(): Promise<BrainData> {
    await this.maybeRefreshCodemap()
    const [dangerZones, contracts, stability, decisions, coChanges, boundaries, config, analysis] =
      await Promise.all([
        this.getDangerZones(),
        this.getContracts(),
        this.getStabilityRecords(),
        this.getDecisions(),
        this.getCoChanges(),
        this.getBoundaries(),
        this.cachedJson<MathaConfig>(path.join(this.mathaDir, 'config.json')),
        this.cachedJson<AnalysisState>(path.join(this.mathaDir, 'cortex', 'analysis.json')),
      ])

    let fileLastChanged: Record<string, string> | undefined
    if (analysis?.files) {
      fileLastChanged = {}
      for (const [file, data] of Object.entries(analysis.files)) {
        fileLastChanged[file] = data.lastChanged
      }
    }

    return {
      dangerZones,
      contracts,
      stability,
      decisions,
      coChanges,
      boundaries,
      fileLastChanged,
      frozenFileSeverity: config?.frozenFileSeverity,
    }
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
          data.decisions.length +
          (data.boundaries?.length ?? 0),
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
