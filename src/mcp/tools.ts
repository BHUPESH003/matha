import * as path from 'path'
import * as crypto from 'crypto'
import type { Engine } from '@/core/engine.js'
import {
  findNearDuplicate,
  validateContractInput,
  validateDangerInput,
  validateDecisionInput,
  type Confidence,
} from '@/core/schema.js'
import { recordContract, recordDangerZone, recordDecision } from '@/store/records.js'
import { refreshFromGit } from '@/codemap/index.js'
import { assembleBrief } from '@/retrieve/brief.js'
import type { MatchContext } from '@/retrieve/match.js'

/**
 * MCP tool implementations behind the consolidated surface:
 * matha_brief / matha_match (reads), matha_record (the one write tool),
 * matha_refresh (codemap). Thin: reads go through the Engine (cached),
 * writes through store/records with schema validation. All results are
 * JSON strings; every success carries `diagnostics` so a wrong-brain
 * failure is visible instead of silently empty.
 */

function generateId(): string {
  return crypto.randomBytes(8).toString('hex')
}

function withDiagnostics(engine: Engine, payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, diagnostics: { brainDir: engine.mathaDir } })
}

function rejected(reason: string): string {
  return JSON.stringify({ success: false, error: `Rejected: ${reason}` })
}

// ── READ TOOLS ───────────────────────────────────────────────────────

export async function mathaBrief(
  engine: Engine,
  scope?: string,
  intent?: string,
  filepaths?: string[],
): Promise<string> {
  const brief = await assembleBrief(engine, { scope, intent, filepaths })
  return JSON.stringify(brief)
}

export async function mathaMatch(
  engine: Engine,
  scope: string,
  intent: string,
  filepaths: string[] = [],
): Promise<string> {
  const context: MatchContext = { scope, intent, filepaths }
  const { results, diagnostics } = await engine.match(context)
  const hasCritical = results.some((r) => r.severity === 'critical')
  return JSON.stringify({
    results,
    hasCritical,
    summary: {
      critical: results.filter((r) => r.severity === 'critical').length,
      warning: results.filter((r) => r.severity === 'warning').length,
      info: results.filter((r) => r.severity === 'info').length,
      total: results.length,
    },
    diagnostics,
  })
}

// ── THE ONE WRITE TOOL ───────────────────────────────────────────────

export type RecordType = 'decision' | 'danger' | 'contract'

export interface RecordArgs {
  type?: RecordType
  component?: string
  previous_assumption?: string
  correction?: string
  description?: string
  assertions?: string[]
  confidence?: Confidence
}

/**
 * Agent-recorded knowledge is at most 'probable' — 'confirmed' is reserved
 * for human surfaces (CLI `matha after`, future `matha review`). Retrieval
 * weights confirmed 1.0 vs probable 0.7, so letting agents self-promote
 * would bypass the human review loop (seen in the field on day one).
 */
function capConfidence(requested: Confidence | undefined): Confidence {
  return requested === 'uncertain' ? 'uncertain' : 'probable'
}

export async function mathaRecord(engine: Engine, args: RecordArgs): Promise<string> {
  switch (args.type) {
    case 'decision': {
      const valid = validateDecisionInput(args)
      if (!valid.ok) return rejected(valid.reason!)
      const dup = findNearDuplicate(
        `${args.previous_assumption} ${args.correction}`,
        (await engine.getDecisions()).filter((d) => d.status === 'active'),
        (d) => `${d.previous_assumption} ${d.correction}`,
      )
      if (dup) {
        return rejected(
          `near-duplicate of existing decision '${dup.id}' on '${dup.component}' — already known; record only genuinely new corrections`,
        )
      }
      const id = `${Date.now()}-${generateId()}`
      await recordDecision(engine.mathaDir, {
        id,
        timestamp: new Date().toISOString(),
        component: args.component!,
        previous_assumption: args.previous_assumption!,
        correction: args.correction!,
        trigger: 'mcp-call',
        confidence: capConfidence(args.confidence),
        status: 'active',
        supersedes: null,
        session_id: id,
      })
      return withDiagnostics(engine, { success: true, id })
    }
    case 'danger': {
      const valid = validateDangerInput(args)
      if (!valid.ok) return rejected(valid.reason!)
      const dup = findNearDuplicate(
        args.description!,
        (await engine.getDangerZones()).filter((z) => !z.status || z.status === 'active'),
        (z) => z.description,
      )
      if (dup) {
        return rejected(
          `near-duplicate of existing danger zone '${dup.id}' on '${dup.component}' — already known`,
        )
      }
      const id = `danger-${Date.now()}-${generateId()}`
      await recordDangerZone(engine.mathaDir, {
        id,
        component: args.component!,
        pattern: args.description!,
        description: args.description!,
        confidence: capConfidence(args.confidence),
      })
      return withDiagnostics(engine, { success: true, id })
    }
    case 'contract': {
      const valid = validateContractInput(args)
      if (!valid.ok) return rejected(valid.reason!)
      await recordContract(engine.mathaDir, args.component!, args.assertions!)
      return withDiagnostics(engine, { success: true, component: args.component })
    }
    default:
      return rejected(`type must be one of decision | danger | contract (got '${args.type}')`)
  }
}

// ── CODEMAP ──────────────────────────────────────────────────────────

export async function mathaRefresh(engine: Engine): Promise<string> {
  const repoPath = path.dirname(engine.mathaDir)
  const snapshot = await refreshFromGit(repoPath, engine.mathaDir)
  return withDiagnostics(engine, {
    success: true,
    commitCount: snapshot.commitCount,
    fileCount: snapshot.fileCount,
    summary: snapshot.summary,
  })
}
